/**
 * HTML 发布服务核心（与 Electron / IPC 无关，可独立单元测试）。
 *
 * 把导入存储目录（user/）里的 HTML 文件或含 index.html 的文件夹，
 * 通过本机 HTTP 服务（默认 0.0.0.0:5000）发布出去，局域网 / 公网上的
 * 其它设备即可用 http://<本机IP>:5000/ 访问。
 *
 * 关键点：
 * - 监听 0.0.0.0，允许外部网卡访问（不是只有 127.0.0.1）
 * - 请求路径做了规范化 + 根目录校验，杜绝 ../ 目录穿越
 * - 未指定具体条目时，根路径返回一个可点选的 HTML 索引页
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/** 默认发布端口 */
export const DEFAULT_PORT = 5000;

const HTML_EXTS = ['.html', '.htm'];
const INDEX_NAMES = ['index.html', 'index.htm'];

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
};

/** 根据扩展名返回 Content-Type，未知类型走二进制流 */
export function getMimeType(filePath) {
  return MIME_TYPES[path.extname(String(filePath)).toLowerCase()] || 'application/octet-stream';
}

/** 校验并归一化端口，非法返回 null */
export function normalizePort(port) {
  const num = Number(port);
  if (!Number.isInteger(num) || num < 1 || num > 65535) return null;
  return num;
}

/** 是否为 HTML 文件 */
function isHtmlFile(name) {
  return HTML_EXTS.includes(path.extname(String(name)).toLowerCase());
}

/**
 * 在目录里挑一个可作为入口的 HTML 文件：
 * index.html / index.htm 优先，其次取第一个 .html / .htm。
 */
export function findEntryHtml(dir) {
  for (const name of INDEX_NAMES) {
    try {
      if (fs.statSync(path.join(dir, name)).isFile()) return name;
    } catch {
      /* 不存在则继续 */
    }
  }
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!isHtmlFile(name)) continue;
    try {
      if (fs.statSync(path.join(dir, name)).isFile()) return name;
    } catch {
      /* 跳过不可访问项 */
    }
  }
  return null;
}

/**
 * 列出存储目录里可发布的 HTML 条目（顶层 .html 文件、含 HTML 的文件夹）。
 * @returns {Array<{name:string, kind:'file'|'folder', url:string, entryFile?:string, size:number}>}
 */
export function listHtmlEntries(rootDir) {
  if (!rootDir) return [];
  let entries = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const items = [];
  for (const entry of entries) {
    // 跳过隐藏文件与导入索引
    if (entry.name.startsWith('.')) continue;
    const target = path.join(rootDir, entry.name);
    let size = 0;
    try {
      size = fs.statSync(target).size;
    } catch {
      size = 0;
    }
    if (entry.isFile()) {
      if (!isHtmlFile(entry.name)) continue;
      items.push({
        name: entry.name,
        kind: 'file',
        url: `/${encodeURIComponent(entry.name)}`,
        size,
      });
      continue;
    }
    if (!entry.isDirectory()) continue;
    const entryFile = findEntryHtml(target);
    if (!entryFile) continue;
    items.push({
      name: entry.name,
      kind: 'folder',
      url: `/${encodeURIComponent(entry.name)}/${encodeURIComponent(entryFile)}`,
      entryFile,
      size,
    });
  }
  return items;
}

/**
 * 把请求 URL 路径解析为磁盘绝对路径。
 * 做了 decodeURI + normalize，并校验结果仍位于 rootDir 内，防目录穿越。
 * @returns {string|null} 越权或非法时返回 null
 */
export function resolveRequestPath(rootDir, urlPath) {
  const root = path.resolve(String(rootDir || ''));
  if (!root) return null;
  const raw = String(urlPath || '/').split('?')[0].split('#')[0];
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null; // 非法百分号编码
  }
  // 去掉开头的 / 或 \ 后做路径规范化（会保留 .. 段，交由下方 resolve 校验）
  const relative = decoded.replace(/^[\\/]+/, '');
  const target = path.resolve(root, path.normalize(relative));
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

/** 本机的局域网 IPv4 地址（已去重，不含回环） */
export function getLanAddresses() {
  const result = [];
  const interfaces = os.networkInterfaces();
  for (const list of Object.values(interfaces || {})) {
    for (const info of list || []) {
      const isIPv4 = info.family === 'IPv4' || info.family === 4;
      if (!isIPv4 || info.internal) continue;
      if (!result.includes(info.address)) result.push(info.address);
    }
  }
  return result;
}

/** 生成可访问地址列表：本机回环在前，局域网地址在后 */
export function buildAccessUrls(port) {
  const portNum = normalizePort(port);
  if (portNum === null) return [];
  return ['127.0.0.1', ...getLanAddresses()].map((ip) => `http://${ip}:${portNum}/`);
}

/* ---------------- 服务运行状态（模块级单例） ---------------- */

let server = null;
let state = {
  running: false,
  port: 0,
  rootDir: '',
  entry: null,
  urls: [],
};

/** 当前服务状态（副本） */
export function getServerStatus() {
  return {
    running: state.running,
    port: state.port,
    rootDir: state.rootDir,
    entry: state.entry ? { ...state.entry } : null,
    urls: [...state.urls],
  };
}

function sendHtml(res, statusCode, title, body) {
  const html = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:-apple-system,'Segoe UI',Roboto,sans-serif;color:#333;padding:32px;line-height:1.6}
a{color:#1a73e8;text-decoration:none}a:hover{text-decoration:underline}
code{background:#f4f5f7;padding:2px 6px;border-radius:4px}</style>
</head>
<body><h1>${title}</h1>${body}</body></html>`;
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

/** 未指定条目时的根路径索引页 */
function sendIndexPage(res, rootDir, entries) {
  const isEmpty = entries.length === 0;
  const list = isEmpty
    ? '<p>存储目录里还没有可发布的 HTML，请先在「首页」导入 .html 文件或含 index.html 的文件夹。</p>'
    : `<ul>${entries
        .map(
          (item) =>
            `<li><a href="${item.url}">${item.name}</a> <small>(${
              item.kind === 'file' ? 'HTML 文件' : `文件夹 · ${item.entryFile}`
            })</small></li>`
        )
        .join('')}</ul>`;
  sendHtml(res, 200, 'maxbox HTML 发布', `${list}<p><small>服务目录：<code>${rootDir}</code></small></p>`);
}

async function sendFile(res, filePath, stat) {
  res.writeHead(200, {
    'Content-Type': getMimeType(filePath),
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  });
  const stream = fs.createReadStream(filePath);
  try {
    for await (const chunk of stream) {
      if (!res.write(chunk)) {
        await new Promise((resolve) => res.once('drain', resolve));
      }
    }
  } catch {
    try {
      res.destroy();
    } catch {
      /* 客户端已断开 */
    }
    return;
  }
  res.end();
}

/** 处理单个 HTTP 请求 */
async function handleRequest(req, res, rootDir, entry) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendHtml(res, 405, '405 不支持的请求方法', '<p>本服务只提供静态文件读取（GET / HEAD）。</p>');
    return;
  }
  const raw = String(req.url || '/');
  const pathname = raw.split('?')[0].split('#')[0];

  let target = null;
  if (pathname === '/' || pathname === '') {
    if (entry) {
      target = entry.kind === 'folder'
        ? path.join(rootDir, entry.name, entry.entryFile || 'index.html')
        : path.join(rootDir, entry.name);
    } else {
      sendIndexPage(res, rootDir, listHtmlEntries(rootDir));
      return;
    }
  } else {
    target = resolveRequestPath(rootDir, pathname);
    if (!target) {
      sendHtml(res, 403, '403 禁止访问', '<p>请求路径超出发布目录范围。</p>');
      return;
    }
  }

  let stat = null;
  try {
    stat = await fsp.stat(target);
  } catch {
    sendHtml(res, 404, '404 未找到', `<p>找不到资源：<code>${pathname}</code></p>`);
    return;
  }

  if (stat.isDirectory()) {
    const entryFile = findEntryHtml(target);
    if (!entryFile) {
      sendHtml(res, 404, '404 未找到', `<p>该目录内没有可发布的 HTML 文件。</p>`);
      return;
    }
    target = path.join(target, entryFile);
    try {
      stat = await fsp.stat(target);
    } catch {
      sendHtml(res, 404, '404 未找到', '<p>找不到资源。</p>');
      return;
    }
  }

  if (!stat.isFile()) {
    sendHtml(res, 404, '404 未找到', '<p>不支持的资源类型。</p>');
    return;
  }

  if (req.method === 'HEAD') {
    res.writeHead(200, {
      'Content-Type': getMimeType(target),
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    res.end();
    return;
  }

  await sendFile(res, target, stat);
}

/** 按名称在可发布条目里查找；传 null / 空则发布索引页 */
export function resolveEntry(rootDir, entryName) {
  if (!entryName) return null;
  const found = listHtmlEntries(rootDir).find((item) => item.name === entryName);
  return found || null;
}

/**
 * 启动 HTML 发布服务。
 * @param {{rootDir:string, port?:number, entryName?:string|null}} options
 * @returns {Promise<{ok:boolean, error?:string, status?:object}>}
 */
export function startHtmlServer({ rootDir, port = DEFAULT_PORT, entryName = null } = {}) {
  if (server) {
    return Promise.resolve({ ok: false, error: 'HTML 发布服务已在运行。' });
  }
  const portNum = normalizePort(port);
  if (portNum === null) {
    return Promise.resolve({ ok: false, error: `端口不合法：${port}` });
  }
  if (!rootDir) {
    return Promise.resolve({ ok: false, error: '未提供发布目录。' });
  }
  const root = path.resolve(rootDir);
  let stat = null;
  try {
    stat = fs.statSync(root);
  } catch {
    return Promise.resolve({ ok: false, error: `发布目录不存在：${root}` });
  }
  if (!stat.isDirectory()) {
    return Promise.resolve({ ok: false, error: `发布目录不是文件夹：${root}` });
  }

  const entry = resolveEntry(root, entryName);
  const httpServer = http.createServer((req, res) => {
    handleRequest(req, res, root, entry).catch(() => {
      try {
        if (!res.headersSent) sendHtml(res, 500, '500 服务内部错误', '<p>读取资源时出错。</p>');
        res.end();
      } catch {
        /* 连接已断开 */
      }
    });
  });
  httpServer.on('error', (err) => {
    console.error('[html-server] 服务异常：', err);
  });

  return new Promise((resolve) => {
    const onError = (err) => {
      try {
        httpServer.close();
      } catch {
        /* ignore */
      }
      let error = `启动失败：${err && err.message ? err.message : err}`;
      if (err && err.code === 'EADDRINUSE') {
        error = `端口 ${portNum} 已被其它程序占用，请关闭占用程序后重试。`;
      } else if (err && err.code === 'EACCES') {
        error = `没有权限监听端口 ${portNum}，请以管理员身份运行后重试。`;
      }
      resolve({ ok: false, error });
    };
    httpServer.once('error', onError);
    // 监听所有网卡，使局域网 / 公网都能访问
    httpServer.listen(portNum, '0.0.0.0', () => {
      httpServer.removeListener('error', onError);
      server = httpServer;
      state = {
        running: true,
        port: portNum,
        rootDir: root,
        entry,
        urls: buildAccessUrls(portNum),
      };
      resolve({ ok: true, status: getServerStatus() });
    });
  });
}

/** 停止 HTML 发布服务 */
export function stopHtmlServer() {
  if (!server) {
    return Promise.resolve({ ok: true, stopped: false });
  }
  const current = server;
  server = null;
  state = { running: false, port: 0, rootDir: '', entry: null, urls: [] };
  return new Promise((resolve) => {
    // 断开残留的 keep-alive 连接，避免 close 一直挂起
    if (typeof current.closeAllConnections === 'function') {
      try {
        current.closeAllConnections();
      } catch {
        /* ignore */
      }
    }
    current.close(() => resolve({ ok: true, stopped: true }));
  });
}
