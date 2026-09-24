/**
 * 首页「导入文件夹」单元测试
 *
 * 覆盖：
 * - hash 路由（首页 / 我的）
 * - 体积格式化 formatBytes
 * - 已导入列表渲染、导入、删除、打开
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, flush } from '../support/env.mjs';

/** 构造 window.maxboxImport 桥替身 */
function makeBridge() {
  const items = [];
  const calls = [];
  return {
    items,
    calls,
    async getRoot() {
      return 'C:/proj/user';
    },
    async chooseFolder() {
      calls.push(['chooseFolder']);
      return 'C:/data/素材';
    },
    async chooseFile() {
      calls.push(['chooseFile']);
      return 'C:/data/photo.png';
    },
    async import(sourcePath) {
      calls.push(['import', sourcePath]);
      const item = {
        name: '素材',
        path: 'C:/proj/user/素材',
        source: sourcePath,
        importedAt: 1700000000000,
        files: 12,
        size: 2048,
      };
      items.unshift(item);
      return { ok: true, item };
    },
    async importFile(sourcePath) {
      calls.push(['importFile', sourcePath]);
      const item = {
        name: 'photo.png',
        path: 'C:/proj/user/photo.png',
        source: sourcePath,
        importedAt: 1700000000001,
        kind: 'file',
        files: 1,
        size: 999,
      };
      items.unshift(item);
      return { ok: true, item };
    },
    async list() {
      return items.slice();
    },
    async remove(name) {
      calls.push(['remove', name]);
      const idx = items.findIndex((i) => i.name === name);
      if (idx >= 0) items.splice(idx, 1);
      return { ok: true, name };
    },
    async open(name) {
      calls.push(['open', name]);
      return true;
    },
    async openRoot() {
      calls.push(['openRoot']);
      return true;
    },
    resolvePath() {
      return '';
    },
  };
}

/** 构造 window.maxboxPublish 桥替身 */
function makePublishBridge() {
  const calls = [];
  return {
    calls,
    async list() {
      return [];
    },
    async status() {
      return { running: false };
    },
    async start(opts) {
      calls.push(['start', opts]);
      return { ok: true, status: { running: true, urls: ['http://127.0.0.1:5000/'] } };
    },
    async stop() {
      return { ok: true };
    },
    async switch(opts) {
      calls.push(['switch', opts]);
      return { ok: true, status: {} };
    },
    async open(url) {
      calls.push(['open', url]);
      return true;
    },
  };
}

describe('导入文件夹 - 路由', () => {
  let app;

  before(() => {
    app = loadApp();
  });

  after(() => {
    app.cleanup();
  });

  it('默认路由为首页', () => {
    assert.deepEqual([...app.hooks.SUPPORTED_ROUTES], ['mainPage', 'myPage']);
    assert.equal(app.hooks.DEFAULT_ROUTE, 'mainPage');
  });

  it('无效 hash 回退到首页', () => {
    app.window.location.hash = '#notExist';
    assert.equal(app.hooks.getRouteFromHash(), 'mainPage');
  });

  it('navigate 切换页面并高亮侧边栏', async () => {
    app.hooks.navigate('myPage');
    await flush(0);
    assert.ok(app.document.getElementById('myPage').classList.contains('active'));
    const activeNav = [...app.document.querySelectorAll('.nav-item')].find((n) =>
      n.classList.contains('active')
    );
    assert.equal(activeNav.getAttribute('data-route'), 'myPage');
  });

  it('window.router 暴露导航能力', () => {
    assert.equal(typeof app.window.router.navigate, 'function');
    assert.equal(typeof app.window.router.current, 'function');
  });
});

describe('导入文件夹 - 格式化', () => {
  let app;

  before(() => {
    app = loadApp();
  });

  after(() => {
    app.cleanup();
  });

  it('字节格式化', () => {
    assert.equal(app.hooks.formatBytes(512), '512 B');
    assert.equal(app.hooks.formatBytes(2048), '2.0 KB');
    assert.equal(app.hooks.formatBytes(5 * 1024 * 1024), '5.00 MB');
    assert.equal(app.hooks.formatBytes(2 * 1024 * 1024 * 1024), '2.00 GB');
  });

  it('非法值显示 --', () => {
    assert.equal(app.hooks.formatBytes(-1), '--');
    assert.equal(app.hooks.formatBytes(NaN), '--');
    assert.equal(app.hooks.formatBytes(undefined), '--');
  });
});

describe('导入文件夹 - 列表与操作', () => {
  let app;
  let bridge;
  let publish;

  before(() => {
    bridge = makeBridge();
    publish = makePublishBridge();
    app = loadApp({ importBridge: bridge, publishBridge: publish });
  });

  after(() => {
    app.cleanup();
  });

  it('空列表显示占位文案', async () => {
    await app.hooks.loadImports();
    assert.ok(app.document.getElementById('import-list').textContent.includes('暂无导入内容'));
    assert.equal(app.document.getElementById('import-count').textContent, '0 个');
  });

  it('点击「选择文件夹导入」会走选择 → 导入 → 刷新列表', async () => {
    app.document.getElementById('btn-import-folder').click();
    await flush(0);
    await flush(0);

    assert.ok(bridge.calls.some((c) => c[0] === 'chooseFolder'));
    assert.ok(bridge.calls.some((c) => c[0] === 'import' && c[1] === 'C:/data/素材'));

    const listEl = app.document.getElementById('import-list');
    assert.ok(listEl.textContent.includes('素材'), '列表应显示导入的文件夹名');
    assert.equal(app.document.getElementById('import-count').textContent, '1 个');
  });

  it('列表项「转发」调用主进程把该条目转发到公网', async () => {
    const btn = app.document.querySelector('#import-list [data-action="forward"]');
    btn.click();
    await flush(0);
    await flush(0);
    assert.ok(
      publish.calls.some((c) => c[0] === 'start' && c[1] && c[1].entryName === '素材'),
      '应开启转发并把条目名作为 entryName'
    );
    assert.equal(app.window.location.hash, '#myPage', '转发后应跳转到「我的」页');
  });

  it('列表项「删除」调用主进程删除并刷新列表', async () => {
    const btn = app.document.querySelector('#import-list [data-action="remove"]');
    btn.click();
    await flush(0);
    await flush(0);

    assert.ok(bridge.calls.some((c) => c[0] === 'remove' && c[1] === '素材'));
    assert.equal(app.document.getElementById('import-count').textContent, '0 个');
    assert.ok(app.document.getElementById('import-list').textContent.includes('暂无导入内容'));
  });

  it('导入失败时展示错误提示', async () => {
    bridge.import = async () => ({ ok: false, error: '该路径不存在或无法访问。' });
    app.document.getElementById('btn-import-folder').click();
    await flush(0);
    await flush(0);

    const msg = app.document.getElementById('import-message');
    assert.equal(msg.hidden, false);
    assert.ok(msg.textContent.includes('该路径不存在或无法访问。'));
  });
});

describe('导入文件夹 - 导入单个文件', () => {
  let app;
  let bridge;

  before(() => {
    bridge = makeBridge();
    app = loadApp({ importBridge: bridge });
  });

  after(() => {
    app.cleanup();
  });

  it('点击「选择文件导入」走 chooseFile → importFile → 刷新列表', async () => {
    app.document.getElementById('btn-import-file').click();
    await flush(0);
    await flush(0);

    assert.ok(bridge.calls.some((c) => c[0] === 'chooseFile'));
    assert.ok(
      bridge.calls.some((c) => c[0] === 'importFile' && c[1] === 'C:/data/photo.png')
    );

    const listEl = app.document.getElementById('import-list');
    assert.ok(listEl.textContent.includes('photo.png'), '列表应显示导入的文件名');
    assert.equal(app.document.getElementById('import-count').textContent, '1 个');
  });

  it('单文件列表项展示文件图标与「单文件」标记', async () => {
    const itemEl = app.document.querySelector('#import-list .import-item');
    assert.equal(itemEl.getAttribute('data-kind'), 'file');
    assert.ok(itemEl.textContent.includes('单文件'));
    assert.ok(itemEl.textContent.includes('999 B'));
  });
});
