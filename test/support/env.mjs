/**
 * 测试环境：在 jsdom 中真实加载 index.html 的结构，
 * 并执行 src/renderer.js 的源码（去掉 import 行），
 * 最后把 renderer 内部模块作用域里的函数/状态作为 hooks 返回，供断言使用。
 *
 * 说明：
 * - 不做任何源码改动；这是测试专用后门。
 * - renderer.js 顶层访问 document/window/location 等全局对象，
 *   我们在执行前把它们临时映射为 jsdom 的对象，测试结束后还原。
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function readIndexHtml() {
  return readFileSync(join(ROOT, 'index.html'), 'utf8');
}

/* ---------- 全局对象快照 ---------- */

const GLOBAL_NAMES = [
  'window',
  'document',
  'location',
  'sessionStorage',
  'localStorage',
  'history',
  'navigator',
  'fetch',
];

function snapshotGlobals() {
  return GLOBAL_NAMES.map((name) => ({
    name,
    existed: Object.prototype.hasOwnProperty.call(globalThis, name),
    descriptor: Object.getOwnPropertyDescriptor(globalThis, name),
  }));
}

function applyGlobal(name, value) {
  Object.defineProperty(globalThis, name, {
    value,
    writable: true,
    configurable: true,
    enumerable: true,
  });
}

function restoreGlobals(snapshot) {
  for (const s of snapshot) {
    if (s.existed && s.descriptor) {
      Object.defineProperty(globalThis, s.name, s.descriptor);
    } else {
      delete globalThis[s.name];
    }
  }
}

/* ---------- renderer 编译 ---------- */

const RENDERER_SOURCE = readFileSync(join(ROOT, 'src', 'renderer.js'), 'utf8');

const HOOKS_CODE = `
;
return {
  SUPPORTED_ROUTES,
  DEFAULT_ROUTE,
  getRouteFromHash,
  applyRoute,
  navigate,
  formatBytes,
  fmtTime,
  escapeHtml,
  renderImports,
  loadImports,
  loadRootPath,
  importPath,
  removeImport,
  showImportMessage,
  hideImportMessage,
  items: () => importItems,
  setItems(list) { importItems = list; },
  dispose() {
    if (typeof toastTimer !== 'undefined' && toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
  }
};`;

function stripModuleSyntax(src) {
  return src
    .split(/\r?\n/)
    .filter((line) => !/^\s*import\s/.test(line))
    .map((line) => line.replace(/^export\s+/, ''))
    .join('\n');
}

function buildRendererBody() {
  return `${stripModuleSyntax(RENDERER_SOURCE)}\n${HOOKS_CODE}`;
}

/* ---------- 主入口 ---------- */

/**
 * 启动一个完整的“页面 + renderer”环境。
 * 默认在 renderer 代码跑完后补发一次 DOMContentLoaded，
 * 模拟真实浏览器启动流程（设置默认 hash、初始化路由等）。
 *
 * @param {object} [opts]
 * @param {string} [opts.url]
 * @param {object} [opts.importBridge] 注入 window.maxboxImport 替身
 * @param {object} [opts.publishBridge] 注入 window.maxboxPublish 替身
 */
export function loadApp({
  url = 'http://maxbox.test/',
  importBridge = null,
  publishBridge = null,
} = {}) {
  const html = readIndexHtml();
  const dom = new JSDOM(html, {
    url,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  const snapshot = snapshotGlobals();
  applyGlobal('window', window);
  applyGlobal('document', window.document);
  applyGlobal('location', window.location);
  applyGlobal('sessionStorage', window.sessionStorage);
  applyGlobal('localStorage', window.localStorage);
  applyGlobal('history', window.history);
  applyGlobal('navigator', window.navigator);

  // 可选注入 preload 桥替身：模拟 window.maxboxImport（导入文件夹 IPC）。
  if (importBridge) {
    Object.defineProperty(window, 'maxboxImport', {
      value: importBridge,
      writable: true,
      configurable: true,
    });
  }

  // 可选注入 preload 桥替身：模拟 window.maxboxPublish（HTML 公网转发 IPC）。
  if (publishBridge) {
    Object.defineProperty(window, 'maxboxPublish', {
      value: publishBridge,
      writable: true,
      configurable: true,
    });
  }

  // 静音 renderer 顶层的 console.log
  const origLog = console.log.bind(console);
  let disposed = false;
  try {
    const fn = new Function(buildRendererBody());
    const hooks = fn.call(window);

    // 模拟真实浏览器在 DOM 解析完成后触发
    window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));

    function cleanup() {
      if (disposed) return;
      disposed = true;
      try {
        hooks.dispose();
      } catch {
        /* ignore */
      }
      restoreGlobals(snapshot);
      window.close();
      console.log = origLog;
    }

    return {
      window,
      document: window.document,
      dom,
      hooks,
      cleanup,
    };
  } catch (err) {
    restoreGlobals(snapshot);
    window.close();
    throw err;
  }
}

/** 等待宏任务/微任务队列清空 */
export function flush(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 触发可冒泡的合成事件 */
export function fire(app, el, type) {
  el.dispatchEvent(new app.window.Event(type, { bubbles: true }));
}

export function setHash(app, hash) {
  app.window.location.hash = hash;
  return flush(0);
}
