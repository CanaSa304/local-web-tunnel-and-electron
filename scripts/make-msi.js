// Windows MSI 打包辅助脚本
//
// 功能：
//   1. 自动将项目内置的 WiX Toolset（.wix/ 下）加入 PATH，
//      找不到时退回使用系统 PATH 中的 candle.exe / light.exe；
//   2. 默认走 npmmirror 的 Electron 发行包镜像（GitHub 不可用时也能下载），
//      已设置 ELECTRON_MIRROR 环境变量时遵循用户设置；
//   3. 调用 electron-forge make 生成 MSI；
//   4. 若已配置代码签名证书（环境变量），构建后自动对 MSI 与应用主程序
//      进行 Authenticode 签名。
//
// 证书环境变量（与 scripts/sign.ps1 一致）：
//   WINDOWS_CERTIFICATE_FILE        .pfx 证书文件路径
//   WINDOWS_CERTIFICATE_PASSWORD    证书密码
//   WINDOWS_CERTIFICATE_THUMBPRINT  证书库（CurrentUser\My）中的证书指纹
//   WINDOWS_TIMESTAMP_SERVER        （可选）RFC3161 时间戳服务器
//
// 用法：
//   npm run make:msi            # 构建当前平台（Windows）MSI
//   npm run make:msi -- -- --platform=win32 --arch=x64
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

// ---------- 1. 准备 WiX Toolset ----------
const wixCandidates = [
  path.join(root, '.wix', 'wix314', 'tools', 'bin'),
  path.join(root, '.wix', 'wix311', 'bin'),
  path.join(root, 'tools', 'wix311'),
];
const wixBin = wixCandidates.find((dir) => fs.existsSync(path.join(dir, 'candle.exe')));

const env = { ...process.env };
if (wixBin) {
  env.PATH = `${wixBin}${path.delimiter}${env.PATH}`;
  console.log(`[make-msi] 使用本地 WiX Toolset：${wixBin}`);
} else {
  console.warn('[make-msi] 未找到本地 WiX Toolset（.wix/），尝试使用系统 PATH 中的 candle/light。');
}
if (!env.ELECTRON_MIRROR) {
  env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
}

function run(cmd, args, opts) {
  const res = spawnSync(cmd, args, {
    cwd: root,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...opts,
  });
  if (res.error) {
    console.error(`[make-msi] 命令执行失败：${cmd}`, res.error.message);
    process.exit(1);
  }
  return res.status == null ? 1 : res.status;
}

// ---------- 2. 构建 ----------
const extra = process.argv.slice(2);
const makeStatus = run('npm', ['run', 'make', ...extra]);
if (makeStatus !== 0) {
  console.error('[make-msi] 构建失败，请检查上方日志。');
  process.exit(makeStatus);
}
console.log('[make-msi] 构建完成，产物位于 out\\make 目录。');

// ---------- 3. 收集待签名文件 ----------
const outRoot = path.join(root, 'out');
function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

const packagedDirs = fs.existsSync(outRoot)
  ? fs.readdirSync(outRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /-win32-/.test(d.name))
      .map((d) => path.join(outRoot, d.name))
  : [];

const signables = [];
for (const dir of packagedDirs) {
  // 打包目录根下的主程序 exe
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.exe')) signables.push(path.join(dir, f));
  }
}
// 所有生成的 MSI
signables.push(...walk(outRoot).filter((f) => f.endsWith('.msi')));

const hasCert = Boolean(env.WINDOWS_CERTIFICATE_FILE || env.WINDOWS_CERTIFICATE_THUMBPRINT);

if (!hasCert) {
  console.log('[make-msi] 未配置代码签名证书，跳过签名。');
  console.log('[make-msi] 需要签名时设置 WINDOWS_CERTIFICATE_FILE(+PASSWORD) 或 WINDOWS_CERTIFICATE_THUMBPRINT 后重新运行 npm run make:msi');
  if (signables.length) {
    console.log('[make-msi] 已生成（未签名）文件：');
    for (const f of signables) console.log('  - ' + f);
  }
  process.exit(0);
}

// ---------- 4. 签名 ----------
const signScript = path.join(root, 'scripts', 'sign.ps1');
if (!fs.existsSync(signScript) || !signables.length) {
  console.error('[make-msi] 已配置证书，但未找到待签名文件或签名脚本，请检查。');
  process.exit(1);
}

const quoted = signables.map((p) => `'${p.replace(/'/g, "''")}'`).join(', ');
const psCommand = `& '${signScript.replace(/'/g, "''")}' -Paths @(${quoted}); exit $LASTEXITCODE`;
const signStatus = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCommand], {
  cwd: root,
  env,
  stdio: 'inherit',
  windowsHide: false,
});
if (signStatus.error || (signStatus.status != null && signStatus.status !== 0)) {
  console.error('[make-msi] 签名失败，请检查证书与网络（时间戳服务器）。');
  process.exit(signStatus.status == null ? 1 : signStatus.status);
}
console.log('[make-msi] 全部产物签名完成。');
process.exit(0);
