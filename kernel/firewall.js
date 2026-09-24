/**
 * Windows 防火墙端口管理（与 Electron / IPC 无关，可独立单元测试）。
 *
 * 通过 netsh advfirewall 完成入站放行规则的增删查：
 *   - 开放端口：netsh advfirewall firewall add rule ... dir=in action=allow protocol=TCP localport=5000
 *   - 关闭端口：netsh advfirewall firewall delete rule ... protocol=TCP localport=5000
 *
 * 增删规则需要管理员权限：
 *   - 已具备权限时直接以 netsh 执行（windowsHide，不弹黑窗）
 *   - 权限不足时回退到 PowerShell Start-Process -Verb RunAs（弹 UAC 授权）
 * 非 Windows 系统直接跳过（返回 skipped），不影响服务本身。
 */
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCallback);

/** 规则名前缀 */
export const RULE_NAME_PREFIX = 'maxbox HTML 发布服务';

/** 按端口生成规则名，便于按端口精确删除 */
export function buildRuleName(port) {
  return `${RULE_NAME_PREFIX} (TCP ${port})`;
}

/**
 * 构造 netsh 参数数组（用 execFile 传数组，避免 shell 转义问题）。
 * @param {'add'|'delete'|'show'} action
 */
export function buildNetshArgs(action, port, ruleName) {
  const base = ['advfirewall', 'firewall', action, 'rule', `name=${ruleName}`];
  if (action === 'add') {
    return [...base, 'dir=in', 'action=allow', 'protocol=TCP', `localport=${port}`];
  }
  if (action === 'delete') {
    return [...base, 'protocol=TCP', `localport=${port}`];
  }
  return base;
}

/** 判断 netsh 输出是否为「没有匹配规则」（删除 / 查询时的正常情况之一） */
export function isNoMatchOutput(text) {
  return /no rules match|没有匹配|找不到|no matching/i.test(String(text || ''));
}

/** 判断是否为权限不足（需要管理员）。
 * 需同时覆盖英文（"requires elevation" / "access is denied"）与中文
 * （"请求的操作需要提升" / "拒绝访问" / "以管理员身份运行" / "系统错误 5"）等本地化报错。 */
export function isAccessDenied(text) {
  const value = String(text || '');
  return (
    /access is denied|access denied|run as an administrator|elevation|requires elevation|提升|拒绝访问|拒绝|需要管理员|以管理员|权限不足|权限|管理员/i.test(
      value
    ) ||
    /\berror\b[^\n]*\b5\b/i.test(value) ||
    /系统错误\s*5|错误\s*5/i.test(value)
  );
}

/** 默认命令执行器：直接跑 netsh */
async function defaultRunner(args) {
  try {
    const { stdout, stderr } = await execFileAsync('netsh', args, {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 15000,
    });
    return { ok: true, code: 0, stdout: stdout || '', stderr: stderr || '' };
  } catch (err) {
    return {
      ok: false,
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout || '',
      stderr: err.stderr || err.message || '',
    };
  }
}

/** 提权执行器：通过 PowerShell Start-Process -Verb RunAs 触发 UAC */
async function elevatedRunner(args, spawn = execFileAsync) {
  const argList = args.map((arg) => `'${String(arg).replace(/'/g, "''")}'`).join(',');
  const psArgs = [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Start-Process -FilePath 'netsh' -ArgumentList @(${argList}) -Verb RunAs -Wait -WindowStyle Hidden`,
  ];
  try {
    const { stdout, stderr } = await spawn('powershell.exe', psArgs, {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 60000,
    });
    return { ok: true, code: 0, stdout: stdout || '', stderr: stderr || '', elevated: true };
  } catch (err) {
    return {
      ok: false,
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout || '',
      stderr: err.stderr || err.message || '',
      elevated: true,
    };
  }
}

/**
 * 执行 netsh，必要时提权重试。
 * @param {'add'|'delete'|'show'} action
 * @param {object} options
 * @param {(args:string[])=>Promise<object>} [options.runner] 注入的执行器（测试用）
 * @param {(args:string[], spawn:Function)=>Promise<object>} [options.elevate] 注入的提权执行器
 * @param {boolean} [options.allowElevation=true] 是否允许弹 UAC 提权
 */
export async function runFirewallCommand(action, port, ruleName, options = {}) {
  const {
    runner = defaultRunner,
    elevate = elevatedRunner,
    allowElevation = true,
  } = options;

  if (process.platform !== 'win32') {
    return { ok: true, skipped: true, note: '当前不是 Windows 系统，跳过防火墙配置。' };
  }

  const args = buildNetshArgs(action, port, ruleName);
  const result = await runner(args);
  if (result.ok) return { ...result, elevated: false, args };

  const output = `${result.stdout}\n${result.stderr}`;
  // 删除 / 查询时「没有匹配规则」视为成功（本就没有该规则）
  if (isNoMatchOutput(output)) {
    return { ok: true, code: 0, stdout: result.stdout, stderr: result.stderr, noMatch: true, args };
  }
  if (!isAccessDenied(output)) {
    return { ok: false, error: (result.stderr || result.stdout || 'netsh 执行失败').trim(), args };
  }
  if (!allowElevation) {
    return {
      ok: false,
      needsAdmin: true,
      error: '修改防火墙需要管理员权限，请授权后重试。',
      args,
    };
  }

  const elevated = await elevate(args, defaultRunner);
  const elevatedOutput = `${elevated.stdout}\n${elevated.stderr}`;
  if (elevated.ok || isNoMatchOutput(elevatedOutput)) {
    return {
      ok: true,
      code: 0,
      stdout: elevated.stdout,
      stderr: elevated.stderr,
      elevated: true,
      args,
    };
  }
  return {
    ok: false,
    needsAdmin: true,
    error: '修改防火墙需要管理员权限，请在 UAC 提示中允许后重试。',
    args,
  };
}

/**
 * 开放指定 TCP 端口的入站访问（已存在同名规则时视为成功）。
 * @returns {Promise<{ok:boolean, error?:string, elevated?:boolean, skipped?:boolean}>}
 */
export async function ensurePortOpen(port, ruleName = buildRuleName(port), options = {}) {
  if (process.platform !== 'win32') {
    return { ok: true, skipped: true, note: '当前不是 Windows 系统，跳过防火墙配置。' };
  }
  const existing = await runFirewallCommand('show', port, ruleName, {
    ...options,
    allowElevation: false,
  });
  if (existing.ok && !existing.noMatch) {
    return { ok: true, alreadyOpen: true, ruleName };
  }
  const result = await runFirewallCommand('add', port, ruleName, options);
  if (!result.ok) return { ok: false, error: result.error, needsAdmin: result.needsAdmin === true };
  return {
    ok: true,
    ruleName,
    elevated: result.elevated === true,
    skipped: result.skipped === true,
  };
}

/**
 * 关闭指定 TCP 端口的入站访问（删除规则；本就没有规则也算成功）。
 */
export async function ensurePortClosed(port, ruleName = buildRuleName(port), options = {}) {
  if (process.platform !== 'win32') {
    return { ok: true, skipped: true, note: '当前不是 Windows 系统，跳过防火墙配置。' };
  }
  const result = await runFirewallCommand('delete', port, ruleName, options);
  if (!result.ok) return { ok: false, error: result.error, needsAdmin: result.needsAdmin === true };
  return {
    ok: true,
    ruleName,
    removed: result.noMatch !== true,
    elevated: result.elevated === true,
    skipped: result.skipped === true,
  };
}

/**
 * 查询端口放行规则是否存在。
 * @returns {Promise<{exists:boolean, error?:string, skipped?:boolean}>}
 */
export async function getPortStatus(port, ruleName = buildRuleName(port), options = {}) {
  if (process.platform !== 'win32') {
    return { exists: false, skipped: true, note: '当前不是 Windows 系统。' };
  }
  const result = await runFirewallCommand('show', port, ruleName, {
    ...options,
    allowElevation: false,
  });
  if (!result.ok) return { exists: false, error: result.error };
  return { exists: result.noMatch !== true, ruleName };
}
