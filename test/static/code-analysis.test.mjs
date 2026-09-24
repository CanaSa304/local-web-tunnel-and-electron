/**
 * 静态代码分析测试
 *
 * 通过读取源码做文本分析，验证「首页导入文件夹」这条主链路是否完整：
 * - 页面结构（index.html 元素齐全、引用 renderer.js）
 * - 渲染进程通过受控 IPC 桥（window.maxboxImport）操作文件系统
 * - 主进程注册导入相关 IPC，且内容存储目录为项目根目录下的 user/
 * - preload 仅通过 contextBridge 暴露白名单 API
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const RENDERER_SRC = readFileSync(join(ROOT, 'src', 'renderer.js'), 'utf8');
const MAIN_SRC = readFileSync(join(ROOT, 'src', 'main.js'), 'utf8');
const HTML_SRC = readFileSync(join(ROOT, 'index.html'), 'utf8');
const PRELOAD_SRC = readFileSync(join(ROOT, 'src', 'preload.js'), 'utf8');

describe('静态分析 - 页面结构', () => {
  it('index.html 包含导入文件夹所需元素', () => {
    const requiredIds = [
      'mainPage',
      'myPage',
      'import-root',
      'import-dropzone',
      'import-message',
      'import-list',
      'import-count',
      'btn-import-folder',
      'btn-import-refresh',
      'storage-userdata',
      'btn-open-userdata',
    ];
    for (const id of requiredIds) {
      assert.ok(HTML_SRC.includes(`id="${id}"`), `index.html 应包含 id="${id}" 的元素`);
    }
  });

  it('index.html 以 module 方式引用 renderer.js', () => {
    assert.ok(HTML_SRC.includes('src="/src/renderer.js"'));
    assert.ok(HTML_SRC.includes('type="module"'));
  });

  it('renderer.js 导入 index.css', () => {
    assert.ok(RENDERER_SRC.includes("import './index.css'"));
  });
});

describe('静态分析 - 导入链路', () => {
  it('渲染进程只通过 window.maxboxImport 访问文件系统', () => {
    assert.ok(RENDERER_SRC.includes('window.maxboxImport'), '应通过 preload 桥访问导入能力');
    assert.ok(
      !/\brequire\(|\bfs\./.test(RENDERER_SRC),
      '渲染进程不应直接使用 Node.js 能力'
    );
  });

  it('主进程注册导入相关 IPC 处理器', () => {
    for (const channel of [
      'import:get-root',
      'import:choose-folder',
      'import:folder',
      'import:list',
      'import:remove',
      'import:open',
      'import:open-root',
    ]) {
      assert.ok(MAIN_SRC.includes(`'${channel}'`), `main.js 应注册 ${channel}`);
    }
  });

  it('导入内容保存到项目根目录下的 user/', () => {
    assert.ok(/'user'/.test(MAIN_SRC), '存储目录应为 user');
    assert.ok(/app\.getAppPath\(\)/.test(MAIN_SRC), '开发模式应基于项目根目录');
  });

  it('删除只允许作用于存储目录内的一级子目录（防越权）', () => {
    assert.ok(/startsWith\(/.test(MAIN_SRC), '删除前应校验目标仍在存储目录内');
  });
});

describe('静态分析 - HTML 公网转发链路', () => {
  it('index.html 包含转发面板所需元素', () => {
    const requiredIds = [
      'publish-panel',
      'publish-entry',
      'publish-port',
      'publish-urls',
      'publish-message',
      'btn-publish-start',
      'btn-publish-stop',
      'btn-publish-refresh',
    ];
    for (const id of requiredIds) {
      assert.ok(HTML_SRC.includes(`id="${id}"`), `index.html 应包含 id="${id}" 的元素`);
    }
  });

  it('主进程注册转发相关 IPC 处理器', () => {
    for (const channel of [
      'publish:list',
      'publish:start',
      'publish:stop',
      'publish:status',
    ]) {
      assert.ok(MAIN_SRC.includes(`'${channel}'`), `main.js 应注册 ${channel}`);
    }
  });

  it('主进程退出前会自动停止转发并关闭防火墙端口', () => {
    assert.ok(/before-quit/.test(MAIN_SRC), '应在退出前处理转发收尾');
    assert.ok(/stopPublish\(\)/.test(MAIN_SRC), '退出时应调用 stopPublish');
  });

  it('渲染进程只通过 window.maxboxPublish 操作转发', () => {
    assert.ok(RENDERER_SRC.includes('window.maxboxPublish'), '应通过 preload 桥访问转发能力');
    assert.ok(
      PRELOAD_SRC.includes("exposeInMainWorld('maxboxPublish'"),
      'preload 应暴露 maxboxPublish 命名空间'
    );
  });
});

describe('静态分析 - 安全与基础设置', () => {
  it('preload 仅通过 contextBridge 暴露白名单 API', () => {
    assert.ok(PRELOAD_SRC.includes('contextBridge'), '应使用 contextBridge');
    assert.ok(
      PRELOAD_SRC.includes("exposeInMainWorld('maxboxImport'"),
      '应暴露 maxboxImport 命名空间'
    );
    assert.ok(
      !/ipcRenderer\.(send|sendSync|on|once)\s*\(/.test(PRELOAD_SRC),
      '不应使用 send / sendSync / on 等非受控通信'
    );
  });

  it('main.js 未启用 nodeIntegration 且配置了 preload', () => {
    assert.ok(MAIN_SRC.includes('preload'), '应配置 preload');
    assert.ok(!/nodeIntegration\s*:\s*true/.test(MAIN_SRC), '不应显式启用 nodeIntegration');
  });

  it('main.js 保留浅色主题、无菜单栏、squirrel 启动处理', () => {
    assert.ok(/nativeTheme\.themeSource\s*=\s*['"]light['"]/.test(MAIN_SRC));
    assert.ok(/Menu\.setApplicationMenu\(null\)/.test(MAIN_SRC));
    assert.ok(MAIN_SRC.includes('electron-squirrel-startup'));
  });
});
