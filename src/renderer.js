import './index.css';

/* ==============================
 *  渲染进程入口
 *  首页：导入文件夹（内容保存到项目根目录下的 user/）
 *  与主进程 / 文件系统的交互全部走 preload 暴露的 window.maxboxImport。
 * ============================== */

// preload 桥（jsdom 单测等无桥环境下为 null，此时列表渲染为空、按钮不可用）
const importBridge = window.maxboxImport || null;
// HTML 公网转发桥（无桥环境下转发功能不可用）
const publishBridge = window.maxboxPublish || null;

/* ==============================
 *  Hash-based Router (无刷新路由)（首页 / 我的）
 * ============================== */

const SUPPORTED_ROUTES = ['mainPage', 'myPage'];
const DEFAULT_ROUTE = 'mainPage';

function getRouteFromHash() {
  const hash = window.location.hash.replace(/^#/, '').trim();
  if (!hash || !SUPPORTED_ROUTES.includes(hash)) {
    return DEFAULT_ROUTE;
  }
  return hash;
}

function applyRoute(routeName) {
  document.querySelectorAll('.nav-item').forEach((navEl) => {
    navEl.classList.toggle('active', navEl.getAttribute('data-route') === routeName);
  });
  document.querySelectorAll('.page').forEach((pageEl) => {
    pageEl.classList.toggle('active', pageEl.id === routeName);
  });
}

function navigate(routeName) {
  if (!SUPPORTED_ROUTES.includes(routeName)) {
    routeName = DEFAULT_ROUTE;
  }
  if (window.location.hash !== `#${routeName}`) {
    window.location.hash = routeName;
  } else {
    applyRoute(routeName);
  }
}

window.addEventListener('hashchange', () => {
  applyRoute(getRouteFromHash());
});

document.addEventListener('click', (e) => {
  const navEl = e.target.closest('.nav-item');
  if (!navEl) return;
  e.preventDefault();
  const route = navEl.getAttribute('data-route');
  if (route) navigate(route);
});

// 导出供调试 / 其他窗口脚本使用
window.router = {
  navigate,
  current: getRouteFromHash,
};

/* ==============================
 *  首页：导入文件夹
 * ============================== */

// 已导入文件夹列表（最新在前）
let importItems = [];
// 正在导入：避免重复点击 / 拖拽并发写入
let importBusy = false;

const dropzoneEl = () => document.getElementById('import-dropzone');
const listEl = () => document.getElementById('import-list');
const countEl = () => document.getElementById('import-count');
const messageEl = () => document.getElementById('import-message');
const rootTextEl = () => document.getElementById('import-root');
const importBtnEl = () => document.getElementById('btn-import-folder');
const fileBtnEl = () => document.getElementById('btn-import-file');

/** 字节大小格式化 */
function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '--';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 时间戳 → 本地可读时间 */
function fmtTime(ts) {
  if (!ts) return '--';
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleString('zh-CN', { hour12: false });
}

/** HTML 转义，避免文件夹名中的特殊字符破坏结构 */
function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);
}

/** 显示导入提示条；kind: 'error' | 'ok' */
function showImportMessage(text, kind = 'error') {
  const el = messageEl();
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('is-ok', kind === 'ok');
  el.hidden = false;
}

function hideImportMessage() {
  const el = messageEl();
  if (el) el.hidden = true;
}

/** 轻提示 toast */
let toastTimer = null;
function showToast(text) {
  let toast = document.querySelector('.mypage-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'mypage-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
}

/** 去除文件名的格式后缀名（保留文件夹名不变） */
function stripExtension(name) {
  const idx = name.lastIndexOf('.');
  if (idx <= 0) return name; // 无扩展名或以点开头的隐藏文件
  return name.slice(0, idx);
}

/** 渲染已导入列表 */
function renderImports() {
  const root = listEl();
  if (!root) return;

  if (countEl()) {
    countEl().textContent = `${importItems.length} 个`;
  }

  if (importItems.length === 0) {
    root.innerHTML = '<div class="import-empty">暂无导入内容</div>';
    return;
  }

  root.innerHTML = importItems
    .map(
      (item) => {
        const isFile = item.kind === 'file';
        const icon = isFile ? '📄' : '📁';
        const fileLabel = isFile
          ? '单文件'
          : `${escapeHtml(String(item.files ?? 0))} 个文件`;
        const displayName = isFile ? stripExtension(item.name) : item.name;
        return `
    <div class="import-item" data-name="${escapeHtml(item.name)}" data-kind="${isFile ? 'file' : 'folder'}">
      <div class="import-item-icon">${icon}</div>
      <div class="import-item-main">
        <div class="import-item-name" title="${escapeHtml(item.name)}">${escapeHtml(displayName)}</div>
        <div class="import-item-meta">
          <span>${fileLabel}</span>
          <span>${formatBytes(item.size)}</span>
          <span>导入于 ${fmtTime(item.importedAt)}</span>
        </div>
      </div>
      <div class="import-item-actions">
        <button type="button" class="btn-ghost import-btn" data-action="forward">转发</button>
        <button type="button" class="btn-ghost import-btn is-danger" data-action="remove">删除</button>
      </div>
    </div>`;
      }
    )
    .join('');
}

/** 拉取已导入列表 */
async function loadImports() {
  if (!importBridge) return [];
  try {
    const items = await importBridge.list();
    importItems = Array.isArray(items) ? items : [];
    renderImports();
  } catch (err) {
    console.error('读取导入列表失败：', err);
    showImportMessage('读取导入列表失败，请重试。');
  }
  return importItems;
}

/** 显示内容存储目录 */
async function loadRootPath() {
  if (!importBridge) return '';
  try {
    const root = await importBridge.getRoot();
    if (rootTextEl()) rootTextEl().textContent = root || '--';
    if (document.getElementById('storage-userdata')) {
      document.getElementById('storage-userdata').textContent = root || '--';
    }
    return root || '';
  } catch (err) {
    console.error('读取存储目录失败：', err);
    return '';
  }
}

/**
 * 导入指定路径。
 * @param {string} sourcePath 源路径
 * @param {'folder'|'file'|'any'} [mode='folder'] 导入模式：
 *   - folder：作为文件夹导入（importBridge.import）
 *   - file：作为单个文件导入（importBridge.importFile，不限格式）
 *   - any：由主进程自动识别文件 / 文件夹（importBridge.importAny，用于拖拽）
 */
async function importPath(sourcePath, mode = 'folder') {
  if (!importBridge) {
    showImportMessage('当前环境不支持导入（缺少主进程桥接）。');
    return null;
  }
  if (!sourcePath) return null;
  if (importBusy) return null;

  importBusy = true;
  if (importBtnEl()) importBtnEl().disabled = true;
  if (fileBtnEl()) fileBtnEl().disabled = true;
  showImportMessage('正在导入…', 'ok');

  try {
    const api =
      mode === 'file'
        ? importBridge.importFile
        : mode === 'any'
          ? importBridge.importAny
          : importBridge.import;
    const res = await api.call(importBridge, sourcePath);
    if (res && res.ok) {
      hideImportMessage();
      showToast(`已导入：${res.item ? res.item.name : ''}`);
      await loadImports();
      return res.item || null;
    }
    showImportMessage((res && res.error) || '导入失败，请重试。');
    return null;
  } catch (err) {
    console.error('导入失败：', err);
    showImportMessage('导入失败，请重试。');
    return null;
  } finally {
    importBusy = false;
    if (importBtnEl()) importBtnEl().disabled = false;
    if (fileBtnEl()) fileBtnEl().disabled = false;
  }
}

/** 删除已导入的文件夹 */
async function removeImport(name) {
  if (!importBridge || !name) return;
  try {
    const res = await importBridge.remove(name);
    if (res && res.ok) {
      showToast(`已删除：${name}`);
      await loadImports();
    } else {
      showImportMessage((res && res.error) || '删除失败，请重试。');
    }
  } catch (err) {
    console.error('删除失败：', err);
    showImportMessage('删除失败，请重试。');
  }
}

/**
 * 转发某个导入项到公网（HTML 公网转发）。
 * 复用 kernel 的发布服务：主进程启动 HTTP 服务并放行 Windows 防火墙端口，
 * 之后跳转到「我的」页展示访问地址。
 * @param {string} name 导入项名称（文件夹名或文件名），作为发布 entryName
 */
async function forwardImport(name) {
  if (!name) return;
  if (!publishBridge) {
    showImportMessage('当前环境不支持公网转发（缺少主进程桥接）。');
    return;
  }
  try {
    // 转发服务已在运行时切换发布内容，否则开启转发。
    let res = await publishBridge.start({ entryName: name });
    if (res && !res.ok && /已在运行/.test(res.error || '')) {
      res = await publishBridge.switch({ entryName: name });
    }
    if (res && res.ok) {
      hideImportMessage();
      showToast(`已转发到公网：${name}`);
      navigate('myPage');
      await refreshPublishStatus();
    } else {
      showImportMessage((res && res.error) || '转发失败，请重试。');
    }
  } catch (err) {
    console.error('转发失败：', err);
    showImportMessage('转发失败，请重试。');
  }
}

/* ---------- 事件绑定：选择文件夹 / 刷新 / 列表操作 ---------- */

document.addEventListener('click', async (e) => {
  // 选择文件夹导入
  if (e.target.closest('#btn-import-folder')) {
    e.preventDefault();
    if (!importBridge) {
      showImportMessage('当前环境不支持导入（缺少主进程桥接）。');
      return;
    }
    const picked = await importBridge.chooseFolder();
    if (picked) await importPath(picked);
    return;
  }

  // 选择单个文件导入（不限格式）
  if (e.target.closest('#btn-import-file')) {
    e.preventDefault();
    if (!importBridge) {
      showImportMessage('当前环境不支持导入（缺少主进程桥接）。');
      return;
    }
    const picked = await importBridge.chooseFile();
    if (picked) await importPath(picked, 'file');
    return;
  }

  // 刷新列表
  if (e.target.closest('#btn-import-refresh')) {
    e.preventDefault();
    await loadImports();
    return;
  }

  // 列表内操作：转发 / 删除
  const actionBtn = e.target.closest('#import-list [data-action]');
  if (actionBtn) {
    const itemEl = actionBtn.closest('.import-item');
    const name = itemEl ? itemEl.dataset.name : '';
    if (!name) return;
    if (actionBtn.dataset.action === 'forward') {
      await forwardImport(name);
    } else if (actionBtn.dataset.action === 'remove') {
      await removeImport(name);
    }
  }
});

/* ---------- 拖拽导入 ---------- */

['dragenter', 'dragover'].forEach((type) => {
  document.addEventListener(type, (e) => {
    const zone = dropzoneEl();
    if (!zone) return;
    e.preventDefault();
    zone.classList.add('is-over');
  });
});

['dragleave', 'dragend'].forEach((type) => {
  document.addEventListener(type, (e) => {
    const zone = dropzoneEl();
    if (!zone) return;
    if (type === 'dragleave' && zone.contains(e.relatedTarget)) return;
    zone.classList.remove('is-over');
  });
});

document.addEventListener('drop', async (e) => {
  const zone = dropzoneEl();
  if (zone) zone.classList.remove('is-over');
  e.preventDefault();
  if (!importBridge) return;

  const files = e.dataTransfer ? Array.from(e.dataTransfer.files || []) : [];
  for (const file of files) {
    const fullPath = importBridge.resolvePath(file);
    if (fullPath) {
      // 自动识别拖入的是文件夹还是单个文件
      await importPath(fullPath, 'any');
    }
  }
});

/* ==============================
 *  「我的」页面：存储目录
 * ============================== */

document.addEventListener('click', (e) => {
  // 打开导入内容目录
  if (e.target.closest('#btn-open-userdata')) {
    e.preventDefault();
    importBridge?.openRoot();
    return;
  }
  // 复制目录路径
  if (e.target.closest('#btn-copy-userdata')) {
    e.preventDefault();
    const p = document.getElementById('storage-userdata')?.textContent?.trim() || '';
    if (!p || p === '--') return;
    navigator.clipboard
      ?.writeText(p)
      .then(() => showToast('已复制目录路径'))
      .catch(() => showToast('复制失败，请手动选择复制'));
    return;
  }
});

/* ==============================
 *  「我的」页面：HTML 公网转发
 *  开启 → 主进程启动 HTTP 服务（0.0.0.0:5000）并放行 Windows 防火墙 5000 端口
 *  停止 → 主进程停服务并删除防火墙放行规则
 * ============================== */

// 可发布的 HTML 条目
let publishEntries = [];
// 已发布的访问地址
let publishUrls = [];
// 正在进行开启 / 停止，避免重复点击
let publishBusy = false;

const publishSelectEl = () => document.getElementById('publish-entry');
const publishMsgEl = () => document.getElementById('publish-message');
const publishUrlsEl = () => document.getElementById('publish-urls');
const publishBadgeEl = () => document.getElementById('publish-badge');
const publishTextEl = () => document.getElementById('publish-text');
const publishPortEl = () => document.getElementById('publish-port');
const publishStartBtnEl = () => document.getElementById('btn-publish-start');
const publishStopBtnEl = () => document.getElementById('btn-publish-stop');
const publishOpenBtnEl = () => document.getElementById('btn-publish-open');

/** 显示转发提示条；kind: 'error' | 'ok' */
function showPublishMessage(text, kind = 'error') {
  const el = publishMsgEl();
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('is-ok', kind === 'ok');
  el.hidden = false;
}

function hidePublishMessage() {
  const el = publishMsgEl();
  if (el) el.hidden = true;
}

/** 渲染可发布条目下拉框 */
function renderPublishEntries() {
  const select = publishSelectEl();
  if (!select) return;
  const current = select.value;
  const options = ['<option value="">（全部内容 · 索引页）</option>']
    .concat(
      publishEntries.map((item) => {
        const suffix = item.kind === 'folder' ? `（文件夹 · ${escapeHtml(item.entryFile || '')}）` : '';
        return `<option value="${escapeHtml(item.name)}">${escapeHtml(item.name)}${suffix}</option>`;
      })
    )
    .join('');
  select.innerHTML = options;
  if (publishEntries.some((item) => item.name === current)) select.value = current;
}

/** 拉取可发布条目 */
async function loadPublishEntries() {
  if (!publishBridge) return [];
  try {
    const items = await publishBridge.list();
    publishEntries = Array.isArray(items) ? items : [];
    renderPublishEntries();
  } catch (err) {
    console.error('读取可发布 HTML 列表失败：', err);
  }
  return publishEntries;
}

/** 渲染访问地址列表 */
function renderPublishUrls(urls) {
  const ul = publishUrlsEl();
  if (!ul) return;
  publishUrls = Array.isArray(urls) ? urls : [];
  if (publishUrls.length === 0) {
    ul.hidden = true;
    ul.innerHTML = '';
    return;
  }
  ul.hidden = false;
  ul.innerHTML = publishUrls
    .map(
      (url, index) => `
    <li class="publish-url-item">
      <code class="storage-path">${escapeHtml(url)}</code>
      <button type="button" class="btn-ghost" data-publish-copy="${index}">复制</button>
      <button type="button" class="btn-ghost" data-publish-open="${index}">打开</button>
    </li>`
    )
    .join('');
}

/** 渲染转发状态（徽标 / 文案 / 按钮可用性 / 地址列表） */
function renderPublishState(status = {}) {
  const running = status.running === true;
  const port = status.port || 5000;
  if (publishPortEl()) publishPortEl().textContent = String(port);

  if (publishBadgeEl()) {
    publishBadgeEl().textContent = running ? '已开启' : '未开启';
    publishBadgeEl().classList.toggle('is-on', running);
    publishBadgeEl().classList.toggle('is-off', !running);
  }
  if (publishTextEl()) {
    const target = status.entry ? status.entry.name : '索引页（全部内容）';
    publishTextEl().textContent = running
      ? `端口 ${port} 已在防火墙放行 · 当前发布：${target}`
      : '未开启转发';
  }
  if (publishStartBtnEl()) publishStartBtnEl().disabled = running || publishBusy;
  if (publishStopBtnEl()) publishStopBtnEl().disabled = !running || publishBusy;
  if (publishOpenBtnEl()) publishOpenBtnEl().disabled = !running;
  renderPublishUrls(running ? status.urls : []);
}

/** 从主进程同步一次真实状态 */
async function refreshPublishStatus() {
  if (!publishBridge) return null;
  try {
    const status = await publishBridge.status();
    renderPublishState(status || {});
    return status;
  } catch (err) {
    console.error('读取转发状态失败：', err);
    return null;
  }
}

/** 设置按钮 busy 态 */
function setPublishBusy(busy) {
  publishBusy = busy;
  const start = publishStartBtnEl();
  const stop = publishStopBtnEl();
  if (start) start.disabled = busy;
  if (stop) stop.disabled = busy;
}

/** 开启转发 */
async function startPublishAction() {
  if (!publishBridge) {
    showPublishMessage('当前环境不支持 HTML 转发（缺少主进程桥接）。');
    return;
  }
  if (publishBusy) return;
  setPublishBusy(true);
  hidePublishMessage();
  const entryName = publishSelectEl() ? publishSelectEl().value || null : null;
  try {
    const res = await publishBridge.start({ entryName });
    if (res && res.ok) {
      renderPublishState(res.status || {});
      showPublishMessage('已开启转发，Windows 防火墙已放行 TCP 5000 端口。', 'ok');
      showToast('已开启 HTML 转发');
    } else {
      showPublishMessage((res && res.error) || '开启转发失败，请重试。');
    }
  } catch (err) {
    console.error('开启转发失败：', err);
    showPublishMessage('开启转发失败，请重试。');
  } finally {
    setPublishBusy(false);
    await refreshPublishStatus();
  }
}

/** 停止转发（同时关闭防火墙端口） */
async function stopPublishAction() {
  if (!publishBridge) return;
  if (publishBusy) return;
  setPublishBusy(true);
  hidePublishMessage();
  try {
    const res = await publishBridge.stop();
    if (res && res.ok) {
      showPublishMessage('已停止转发，防火墙 5000 端口已关闭。', 'ok');
      showToast('已停止 HTML 转发');
    } else {
      showPublishMessage((res && res.error) || '停止转发失败，请重试。');
    }
  } catch (err) {
    console.error('停止转发失败：', err);
    showPublishMessage('停止转发失败，请重试。');
  } finally {
    setPublishBusy(false);
    await refreshPublishStatus();
  }
}

/** 在系统默认浏览器里打开某个地址 */
function openPublishUrl(index) {
  const url = publishUrls[index];
  if (!url) return;
  publishBridge?.open(url);
}

/* ---------- 事件绑定：转发面板 ---------- */

document.addEventListener('click', async (e) => {
  // 刷新可发布列表
  if (e.target.closest('#btn-publish-refresh')) {
    e.preventDefault();
    await loadPublishEntries();
    showToast('已刷新可发布列表');
    return;
  }

  // 开启转发
  if (e.target.closest('#btn-publish-start')) {
    e.preventDefault();
    await startPublishAction();
    return;
  }

  // 停止转发
  if (e.target.closest('#btn-publish-stop')) {
    e.preventDefault();
    await stopPublishAction();
    return;
  }

  // 打开第一个访问地址
  if (e.target.closest('#btn-publish-open')) {
    e.preventDefault();
    openPublishUrl(0);
    return;
  }

  // 地址列表：复制
  const copyBtn = e.target.closest('#publish-urls [data-publish-copy]');
  if (copyBtn) {
    e.preventDefault();
    const url = publishUrls[Number(copyBtn.dataset.publishCopy)];
    if (url) {
      navigator.clipboard
        ?.writeText(url)
        .then(() => showToast('已复制访问地址'))
        .catch(() => showToast('复制失败，请手动选择复制'));
    }
    return;
  }

  // 地址列表：在浏览器打开
  const openBtn = e.target.closest('#publish-urls [data-publish-open]');
  if (openBtn) {
    e.preventDefault();
    openPublishUrl(Number(openBtn.dataset.publishOpen));
  }
});

// 运行中切换发布内容
document.addEventListener('change', async (e) => {
  if (!e.target || e.target.id !== 'publish-entry') return;
  const entryName = e.target.value || null;
  const status = await refreshPublishStatus();
  if (!status || !status.running || !publishBridge) return;
  const res = await publishBridge.switch({ entryName });
  if (res && res.ok) {
    renderPublishState(res.status || {});
    showPublishMessage('已切换发布内容。', 'ok');
  } else {
    showPublishMessage((res && res.error) || '切换发布内容失败。');
  }
});

/* ---------- 启动 ---------- */

document.addEventListener('DOMContentLoaded', () => {
  if (!window.location.hash) {
    window.location.hash = DEFAULT_ROUTE;
  } else {
    applyRoute(getRouteFromHash());
  }
  loadRootPath();
  loadImports();
  loadPublishEntries();
  refreshPublishStatus();
});
