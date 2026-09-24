/**
 * 导入存储核心逻辑集成测试（真实文件系统）
 *
 * 直接调用 src/import-store.js 的纯逻辑，验证：
 * - 单个文件导入（不限格式）：复制、索引、列出、删除
 * - 文件夹导入：递归复制、统计
 * - importEntry 自动识别文件 / 文件夹
 * - 列表同时包含文件夹与文件，且不会列出索引文件本身
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  initImportStore,
  listImports,
  importFile,
  importFolder,
  importEntry,
  removeImport,
} from '../../src/import-store.js';

let storeDir; // 模拟 user/ 存储目录
let workDir; // 存放待导入的源文件 / 文件夹

function makeFile(rel, content = 'hello') {
  const p = join(workDir, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
  return p;
}

function makeDir(rel) {
  const p = join(workDir, rel);
  mkdirSync(p, { recursive: true });
  return p;
}

describe('导入存储核心 - 单文件', () => {
  before(() => {
    storeDir = mkdtempSync(join(tmpdir(), 'maxbox-store-'));
    workDir = mkdtempSync(join(tmpdir(), 'maxbox-work-'));
    initImportStore({ userRoot: storeDir });
  });

  after(() => {
    rmSync(storeDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  it('导入单个文件（任意格式）并列出', async () => {
    const src = makeFile('photo.png', 'binary-content');
    const res = importFile(src);
    assert.equal(res.ok, true, `导入应成功，得到: ${JSON.stringify(res)}`);
    assert.equal(res.item.kind, 'file');
    assert.equal(res.item.files, 1);
    assert.equal(res.item.size, 'binary-content'.length);

    const target = join(storeDir, res.item.name);
    assert.ok(existsSync(target), '目标文件应已复制');
    assert.equal(readFileSync(target, 'utf8'), 'binary-content');

    const list = listImports();
    assert.equal(list.length, 1);
    assert.equal(list[0].kind, 'file');
    assert.equal(list[0].name, res.item.name);
  });

  it('同名文件导入自动加后缀', () => {
    const src = makeFile('dup.txt', 'v1');
    const first = importFile(src);
    const second = importFile(src);
    assert.equal(first.ok && second.ok, true);
    assert.notEqual(first.item.name, second.item.name);
    assert.ok(second.item.name.endsWith('-2'));
    assert.equal(listImports().length, 3);
  });

  it('打开列表中的文件可定位到正确路径', () => {
    const list = listImports();
    const file = list.find((i) => i.kind === 'file');
    assert.ok(file, '应至少有一个文件');
    assert.ok(basename(file.path), file.name);
  });

  it('删除已导入文件会连带删除磁盘文件与索引', () => {
    const list = listImports();
    const target = list[0].name;
    const path = join(storeDir, target);
    assert.ok(existsSync(path));
    const rm = removeImport(target);
    assert.equal(rm.ok, true);
    assert.ok(!existsSync(path), '磁盘文件应被删除');
    assert.ok(!listImports().some((i) => i.name === target), '索引应被移除');
  });

  it('导入不存在的路径应返回失败而非抛错', () => {
    const res = importFile(join(workDir, 'no-such-file.xyz'));
    assert.equal(res.ok, false);
    assert.ok(res.error);
  });
});

describe('导入存储核心 - 文件夹与自动识别', () => {
  before(() => {
    storeDir = mkdtempSync(join(tmpdir(), 'maxbox-store2-'));
    workDir = mkdtempSync(join(tmpdir(), 'maxbox-work2-'));
    initImportStore({ userRoot: storeDir });
  });

  after(() => {
    rmSync(storeDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  it('导入文件夹递归复制并统计文件数', () => {
    const dir = makeDir('album');
    writeFileSync(join(dir, 'a.txt'), 'a');
    writeFileSync(join(dir, 'b.txt'), 'bb');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'c.txt'), 'ccc');

    const res = importFolder(dir);
    assert.equal(res.ok, true, `导入应成功: ${JSON.stringify(res)}`);
    assert.equal(res.item.kind, 'folder');
    assert.equal(res.item.files, 3);

    const list = listImports();
    assert.equal(list.length, 1);
    assert.equal(list[0].kind, 'folder');
  });

  it('importEntry 自动识别文件 / 文件夹', () => {
    const f = makeFile('note.md', 'md');
    const d = makeDir('docs');
    writeFileSync(join(d, 'x.txt'), 'x');

    const r1 = importEntry(f);
    assert.equal(r1.ok, true);
    assert.equal(r1.item.kind, 'file');

    const r2 = importEntry(d);
    assert.equal(r2.ok, true);
    assert.equal(r2.item.kind, 'folder');

    const list = listImports();
    // 前序测试已导入过一个文件夹，这里只需确认两类都被正确识别并入库
    assert.ok(list.some((i) => i.kind === 'file' && i.name === basename(f)));
    assert.ok(list.some((i) => i.kind === 'folder' && i.name === basename(d)));
    assert.deepEqual(
      [...new Set(list.map((i) => i.kind))].sort(),
      ['file', 'folder']
    );
  });

  it('列表不会把索引文件 .maxbox-imports.json 当作导入项', () => {
    // 索引文件由导入逻辑自动写入，确认它不会出现在列表里
    const list = listImports();
    assert.ok(!list.some((i) => i.name === '.maxbox-imports.json'));
  });

  it('删除越权路径（含 ..）应被拒绝', () => {
    const rm = removeImport('../escape');
    assert.equal(rm.ok, false);
  });
});
