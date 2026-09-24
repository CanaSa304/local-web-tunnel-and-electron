/**
 * HTML 公网转发核心集成测试（真实文件系统 + 真实 HTTP 服务）
 *
 * 验证 kernel/ 下的能力：
 * - html-server：条目识别、路径防穿越、服务起停与内容读取
 * - firewall：netsh 参数构造、权限不足 / 无匹配规则的判定、命令执行与提权回退
 * - publish-service：开启时先放行端口、失败回滚、停止时关闭端口
 * 防火墙相关用例全部使用注入的执行器，不会真的改动系统防火墙。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_PORT,
  buildAccessUrls,
  getMimeType,
  getServerStatus,
  listHtmlEntries,
  normalizePort,
  resolveRequestPath,
  startHtmlServer,
  stopHtmlServer,
} from '../../kernel/html-server.js';
import {
  buildNetshArgs,
  buildRuleName,
  ensurePortClosed,
  ensurePortOpen,
  isAccessDenied,
  isNoMatchOutput,
  runFirewallCommand,
} from '../../kernel/firewall.js';
import {
  PUBLISH_PORT,
  getPublishStatus,
  listPublishEntries,
  resetFirewallAdapter,
  setFirewallAdapter,
  startPublish,
  stopPublish,
} from '../../kernel/publish-service.js';

let rootDir; // 模拟 user/ 发布目录
const TEST_PORT = 51337;

function makeFile(rel, content = 'hello') {
  const p = join(rootDir, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
  return p;
}

/** 简易 GET 请求 */
function httpGet(url) {
  return fetch(url).then(async (res) => ({ status: res.status, text: await res.text() }));
}

/** 原始路径 GET（不做 URL 规范化，用于验证服务端的目录穿越防护） */
function rawGet(port, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** 在指定端口上放一个占位服务，用于制造「端口被占用」场景 */
function occupyPort(port) {
  const blocker = http.createServer((_req, res) => res.end('busy'));
  blocker.on('error', () => {
    /* 由调用方断言，避免未捕获异常 */
  });
  return new Promise((resolve) => {
    blocker.listen(port, '0.0.0.0', () => resolve(blocker));
  });
}

function releasePort(blocker) {
  return new Promise((resolve) => {
    if (!blocker) return resolve();
    blocker.close(() => resolve());
  });
}

describe('HTML 发布服务 - 纯函数', () => {
  before(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'maxbox-publish-'));
  });
  after(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('端口归一化：合法端口保留，非法端口返回 null', () => {
    assert.equal(normalizePort(5000), 5000);
    assert.equal(normalizePort('5000'), 5000);
    assert.equal(normalizePort(0), null);
    assert.equal(normalizePort(70000), null);
    assert.equal(normalizePort('abc'), null);
  });

  it('默认发布端口为 5000', () => {
    assert.equal(DEFAULT_PORT, 5000);
    assert.equal(PUBLISH_PORT, 5000);
  });

  it('列出可发布的 HTML 条目（单文件与含 index.html 的文件夹）', () => {
    makeFile('page.html', '<h1>page</h1>');
    makeFile('site/index.html', '<h1>site</h1>');
    makeFile('nohtml/readme.txt', 'txt');
    writeFileSync(join(rootDir, '.maxbox-imports.json'), '{}');

    const items = listHtmlEntries(rootDir);
    const names = items.map((i) => i.name);
    assert.ok(names.includes('page.html'), `应包含 page.html，实际: ${names}`);
    assert.ok(names.includes('site'), `应包含 site，实际: ${names}`);
    assert.ok(!names.includes('nohtml'), '不含 HTML 的文件夹不应出现');
    assert.ok(!names.includes('.maxbox-imports.json'), '索引文件不应出现');

    const page = items.find((i) => i.name === 'page.html');
    assert.equal(page.kind, 'file');
    const site = items.find((i) => i.name === 'site');
    assert.equal(site.kind, 'folder');
    assert.equal(site.entryFile, 'index.html');
    assert.equal(site.url, '/site/index.html');
  });

  it('请求路径解析：正常路径可达，../ 越权被拒绝', () => {
    assert.equal(
      resolveRequestPath(rootDir, '/page.html'),
      join(rootDir, 'page.html'),
      '正常路径应解析到发布目录内'
    );
    assert.equal(
      resolveRequestPath(rootDir, '/site/index.html'),
      join(rootDir, 'site', 'index.html')
    );
    assert.equal(resolveRequestPath(rootDir, '/../secret.txt'), null, '../ 越权应被拒绝');
    assert.equal(resolveRequestPath(rootDir, '/..%2fsecret.txt'), null, '编码后的越权应被拒绝');
    assert.equal(resolveRequestPath(rootDir, '/%ZZ'), null, '非法编码应被拒绝');
  });

  it('扩展名映射到 Content-Type', () => {
    assert.match(getMimeType('a.html'), /text\/html/);
    assert.match(getMimeType('a.css'), /text\/css/);
    assert.equal(getMimeType('a.unknown'), 'application/octet-stream');
  });

  it('访问地址包含回环地址与端口', () => {
    const urls = buildAccessUrls(5000);
    assert.ok(urls.length >= 1);
    assert.ok(urls[0].startsWith('http://127.0.0.1:5000/'));
  });
});

describe('HTML 发布服务 - 起停与访问', () => {
  before(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'maxbox-publish-srv-'));
    makeFile('report.html', '<h1>装箱报告</h1>');
    makeFile('site/index.html', '<h1>站点首页</h1>');
  });
  after(async () => {
    await stopHtmlServer();
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('启动后可通过 HTTP 访问指定 HTML，停止后不可访问', async () => {
    const started = await startHtmlServer({
      rootDir,
      port: TEST_PORT,
      entryName: 'report.html',
    });
    assert.equal(started.ok, true, `启动应成功：${started.error || ''}`);
    assert.equal(getServerStatus().running, true);

    const res = await httpGet(`http://127.0.0.1:${TEST_PORT}/`);
    assert.equal(res.status, 200);
    assert.match(res.text, /装箱报告/);

    const stopped = await stopHtmlServer();
    assert.equal(stopped.ok, true);
    assert.equal(getServerStatus().running, false);

    await assert.rejects(() => fetch(`http://127.0.0.1:${TEST_PORT}/`), '停止后端口应不再响应');
  });

  it('未指定条目时根路径返回索引页，并可直接访问子目录 HTML', async () => {
    const started = await startHtmlServer({ rootDir, port: TEST_PORT });
    assert.equal(started.ok, true);
    const index = await httpGet(`http://127.0.0.1:${TEST_PORT}/`);
    assert.equal(index.status, 200);
    assert.match(index.text, /site/);

    const sub = await httpGet(`http://127.0.0.1:${TEST_PORT}/site/`);
    assert.equal(sub.status, 200);
    assert.match(sub.text, /站点首页/);

    await stopHtmlServer();
  });

  it('目录穿越请求返回 403', async () => {
    const started = await startHtmlServer({ rootDir, port: TEST_PORT });
    assert.equal(started.ok, true);

    const plain = await rawGet(TEST_PORT, '/../package.json');
    assert.equal(plain.status, 403, '未编码的 ../ 越权应返回 403');

    const encoded = await rawGet(TEST_PORT, '/%2e%2e%2fpackage.json');
    assert.equal(encoded.status, 403, '百分号编码的 ../ 越权应返回 403');

    await stopHtmlServer();
  });

  it('端口被占用时返回明确错误', async () => {
    const blocker = await occupyPort(TEST_PORT);
    try {
      const started = await startHtmlServer({ rootDir, port: TEST_PORT });
      assert.equal(started.ok, false);
      assert.match(started.error, /占用/);
    } finally {
      await releasePort(blocker);
    }
  });
});

describe('Windows 防火墙 - 命令构造与判定', () => {
  it('按端口生成规则名', () => {
    assert.equal(buildRuleName(5000), 'maxbox HTML 发布服务 (TCP 5000)');
  });

  it('构造 add / delete / show 的 netsh 参数', () => {
    const add = buildNetshArgs('add', 5000, 'R');
    assert.deepEqual(add, [
      'advfirewall',
      'firewall',
      'add',
      'rule',
      'name=R',
      'dir=in',
      'action=allow',
      'protocol=TCP',
      'localport=5000',
    ]);

    const del = buildNetshArgs('delete', 5000, 'R');
    assert.deepEqual(del, [
      'advfirewall',
      'firewall',
      'delete',
      'rule',
      'name=R',
      'protocol=TCP',
      'localport=5000',
    ]);

    const show = buildNetshArgs('show', 5000, 'R');
    assert.deepEqual(show, ['advfirewall', 'firewall', 'show', 'rule', 'name=R']);
  });

  it('识别权限不足与「无匹配规则」输出', () => {
    assert.equal(isAccessDenied('Access is denied.'), true);
    assert.equal(isAccessDenied('需要管理员权限'), true);
    assert.equal(isAccessDenied('Ok.'), false);
    assert.equal(isNoMatchOutput('No rules match the specified criteria.'), true);
    assert.equal(isNoMatchOutput('找不到匹配的规则'), true);
    assert.equal(isNoMatchOutput('Rule Name: x'), false);
  });
});

describe('Windows 防火墙 - 执行与提权回退', () => {
  const calls = [];
  const makeRunner = (result) => async (args) => {
    calls.push(args);
    return { ok: result.ok !== false, code: 0, stdout: result.stdout || '', stderr: result.stderr || '' };
  };

  it('权限不足时回退到提权执行器（UAC）', async () => {
    calls.length = 0;
    let elevatedArgs = null;
    const res = await runFirewallCommand('add', 5000, 'R', {
      runner: async () => ({
        ok: false,
        code: 1,
        stdout: '',
        stderr: 'The requested operation requires elevation (Run as administrator).',
      }),
      elevate: async (args) => {
        elevatedArgs = args;
        return { ok: true, code: 0, stdout: 'Ok.', stderr: '' };
      },
    });
    assert.equal(res.ok, true, '提权后应成功');
    assert.equal(res.elevated, true);
    assert.ok(elevatedArgs && elevatedArgs[0] === 'advfirewall');
  });

  it('禁止提权且权限不足时返回需要管理员', async () => {
    const res = await runFirewallCommand('add', 5000, 'R', {
      allowElevation: false,
      runner: async () => ({ ok: false, code: 1, stdout: '', stderr: 'Access is denied.' }),
    });
    assert.equal(res.ok, false);
    assert.equal(res.needsAdmin, true);
  });

  it('删除时「无匹配规则」视为成功', async () => {
    const res = await ensurePortClosed(5000, 'R', {
      runner: async () => ({
        ok: false,
        code: 1,
        stdout: 'No rules match the specified criteria.',
        stderr: '',
      }),
    });
    assert.equal(res.ok, true, '本就没有规则时应视为关闭成功');
    assert.equal(res.removed, false);
  });

  it('开放端口：已存在规则时跳过新增', async () => {
    let addCalled = false;
    const runner = async (args) => {
      if (args[2] === 'add') addCalled = true;
      return { ok: true, code: 0, stdout: 'Rule Name: R', stderr: '' };
    };
    const res = await ensurePortOpen(5000, 'R', { runner });
    assert.equal(res.ok, true);
    assert.equal(res.alreadyOpen, true);
    assert.equal(addCalled, false, '规则已存在时不应重复添加');
  });

  it('makeRunner 可用于注入执行并记录参数', async () => {
    calls.length = 0;
    await runFirewallCommand('show', 5000, 'R', { runner: makeRunner({ ok: true }) });
    assert.deepEqual(calls[0], ['advfirewall', 'firewall', 'show', 'rule', 'name=R']);
  });
});

describe('转发编排 - 端口放行与服务联动', () => {
  let opened = [];
  let closed = [];
  const fakeAdapter = {
    ensurePortOpen: async (port, ruleName) => {
      opened.push({ port, ruleName });
      return { ok: true, ruleName };
    },
    ensurePortClosed: async (port, ruleName) => {
      closed.push({ port, ruleName });
      return { ok: true, ruleName, removed: true };
    },
    getPortStatus: async () => ({ exists: true }),
  };

  before(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'maxbox-publish-ctrl-'));
    makeFile('report.html', '<h1>报告</h1>');
    setFirewallAdapter(fakeAdapter);
  });
  after(async () => {
    await stopPublish();
    resetFirewallAdapter();
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('开启转发：先放行端口，再启动服务', async () => {
    opened = [];
    closed = [];
    const res = await startPublish({ rootDir, port: TEST_PORT, entryName: 'report.html' });
    assert.equal(res.ok, true, `开启应成功：${res.error || ''}`);
    assert.equal(opened.length, 1, '应放行一次端口');
    assert.equal(opened[0].port, TEST_PORT);
    assert.match(opened[0].ruleName, /TCP 51337/);
    assert.equal(getPublishStatus().running, true);

    const page = await httpGet(`http://127.0.0.1:${TEST_PORT}/`);
    assert.match(page.text, /报告/);
    assert.ok(listPublishEntries(rootDir).some((i) => i.name === 'report.html'));
  });

  it('停止转发：停服务并关闭端口', async () => {
    closed = [];
    const res = await stopPublish();
    assert.equal(res.ok, true, `停止应成功：${res.error || ''}`);
    assert.equal(closed.length, 1, '应关闭一次端口');
    assert.equal(getPublishStatus().running, false);
    await assert.rejects(() => fetch(`http://127.0.0.1:${TEST_PORT}/`));
  });

  it('服务启动失败时回滚：删除已放行的防火墙规则', async () => {
    const blocker = await occupyPort(TEST_PORT);
    opened = [];
    closed = [];
    try {
      const res = await startPublish({ rootDir, port: TEST_PORT });
      assert.equal(res.ok, false, '端口被占用时应失败');
      assert.equal(opened.length, 1, '应先尝试放行端口');
      assert.equal(closed.length, 1, '失败后应回滚关闭端口');
      assert.equal(res.rollback.ok, true);
      assert.equal(getPublishStatus().running, false);
    } finally {
      await releasePort(blocker);
    }
  });

  it('防火墙放行失败时不启动服务', async () => {
    setFirewallAdapter({
      ensurePortOpen: async () => ({ ok: false, error: '需要管理员权限', needsAdmin: true }),
      ensurePortClosed: async () => ({ ok: true }),
      getPortStatus: async () => ({ exists: false }),
    });
    const res = await startPublish({ rootDir, port: TEST_PORT });
    assert.equal(res.ok, false);
    assert.equal(res.needsAdmin, true);
    assert.equal(getPublishStatus().running, false, '放行失败时不应留下运行中的服务');
    setFirewallAdapter(fakeAdapter);
  });
});
