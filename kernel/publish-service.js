/**
 * HTML 公网转发编排层（与 Electron / IPC 无关，可独立单元测试）。
 *
 * 职责：把「HTTP 发布服务」与「Windows 防火墙端口放行」绑成一次原子操作：
 *   - 开启转发：先放行防火墙端口 → 再启动 HTTP 服务；服务启动失败则回滚删除防火墙规则
 *   - 停止转发：先停 HTTP 服务 → 再删除防火墙规则（关闭端口）
 * 应用退出时调用 stopPublish() 即可保证端口不会残留放行。
 */
import {
  DEFAULT_PORT,
  buildAccessUrls,
  getServerStatus,
  listHtmlEntries,
  startHtmlServer,
  stopHtmlServer,
} from './html-server.js';
import { buildRuleName, ensurePortClosed, ensurePortOpen, getPortStatus } from './firewall.js';

/** 对外发布的端口号 */
export const PUBLISH_PORT = DEFAULT_PORT;

const defaultFirewall = { ensurePortOpen, ensurePortClosed, getPortStatus };
// 可注入的防火墙适配器（测试 / 非 Windows 环境使用）
let firewallAdapter = defaultFirewall;

/** 替换防火墙适配器（单测注入假实现，避免真的改动系统防火墙） */
export function setFirewallAdapter(adapter) {
  firewallAdapter = { ...defaultFirewall, ...(adapter || {}) };
}

/** 恢复默认防火墙适配器 */
export function resetFirewallAdapter() {
  firewallAdapter = defaultFirewall;
}

let activePort = PUBLISH_PORT;
let activeRuleName = buildRuleName(PUBLISH_PORT);
let lastError = '';

/** 当前转发状态（供 UI 展示） */
export function getPublishStatus() {
  const server = getServerStatus();
  return {
    running: server.running,
    port: activePort,
    ruleName: activeRuleName,
    entry: server.entry,
    urls: server.urls.length ? [...server.urls] : buildAccessUrls(activePort),
    lastError,
  };
}

/** 列出可发布的 HTML 条目 */
export function listPublishEntries(rootDir) {
  return listHtmlEntries(rootDir);
}

/**
 * 开启转发：开放防火墙端口 → 启动 HTTP 服务。
 * @param {{rootDir:string, port?:number, entryName?:string|null}} options
 * @returns {Promise<{ok:boolean, error?:string, status?:object, firewall?:object}>}
 */
export async function startPublish({ rootDir, port = PUBLISH_PORT, entryName = null } = {}) {
  const ruleName = buildRuleName(port);
  activePort = port;
  activeRuleName = ruleName;

  const firewall = await firewallAdapter.ensurePortOpen(port, ruleName);
  if (!firewall.ok) {
    lastError = `开放防火墙端口 ${port} 失败：${firewall.error || '未知错误'}`;
    return {
      ok: false,
      error: lastError,
      needsAdmin: firewall.needsAdmin === true,
      firewall,
    };
  }

  const started = await startHtmlServer({ rootDir, port, entryName });
  if (!started.ok) {
    // 服务没起来：回滚防火墙放行，避免端口白白对外敞开
    const rollback = await firewallAdapter.ensurePortClosed(port, ruleName);
    lastError = started.error || '启动 HTML 服务失败。';
    return {
      ok: false,
      error: lastError,
      firewall,
      rollback: { ok: rollback.ok, error: rollback.error },
    };
  }

  lastError = '';
  return { ok: true, status: getPublishStatus(), firewall };
}

/**
 * 停止转发：停止 HTTP 服务 → 删除防火墙规则（关闭端口）。
 * @returns {Promise<{ok:boolean, error?:string, firewall?:object}>}
 */
export async function stopPublish() {
  const port = activePort;
  const ruleName = activeRuleName;
  const stopped = await stopHtmlServer();
  const firewall = await firewallAdapter.ensurePortClosed(port, ruleName);
  if (!firewall.ok) {
    lastError = `关闭防火墙端口 ${port} 失败：${firewall.error || '未知错误'}`;
    return {
      ok: false,
      error: lastError,
      stopped: stopped.stopped === true,
      needsAdmin: firewall.needsAdmin === true,
      firewall,
    };
  }
  lastError = '';
  return { ok: true, stopped: stopped.stopped === true, firewall };
}

/**
 * 切换发布条目（服务运行中生效）：重启 HTTP 服务，防火墙规则保持不变。
 * @returns {Promise<{ok:boolean, error?:string, status?:object}>}
 */
export async function switchPublishEntry({ rootDir, entryName = null } = {}) {
  await stopHtmlServer();
  const started = await startHtmlServer({ rootDir, port: activePort, entryName });
  if (!started.ok) {
    lastError = started.error || '切换发布内容失败。';
    return { ok: false, error: lastError };
  }
  lastError = '';
  return { ok: true, status: getPublishStatus() };
}

/** 查询防火墙端口当前是否已放行 */
export function checkPublishPort(port = activePort) {
  return firewallAdapter.getPortStatus(port, buildRuleName(port));
}
