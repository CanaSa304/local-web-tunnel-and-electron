/**
 * 导入存储核心逻辑（与 Electron 渲染层 / IPC 无关，可独立单元测试）。
 *
 * 首页导入的文件夹或文件统一保存到 USER_ROOT 目录（由 initImportStore 注入）：
 *   - 开发模式（electron-forge start）：<项目根>/user
 *   - 打包运行：<userData>/user（asar 只读，不能写进去）
 * 也可用环境变量 MAXBOX_USER_DIR 覆盖（便于测试 / 自定义位置）。
 *
 * 导入索引（.maxbox-imports.json）记录每个条目的来源、时间、类型与统计信息，
 * 避免每次列表都重新遍历磁盘。
 */
import path from 'node:path';
import fs from 'node:fs';

// 统计目录时的文件数上限，防止超大文件夹把主线程卡死
const MAX_WALK_FILES = 20000;

// 由 initImportStore 在应用启动时注入
let USER_ROOT = '';
let META_FILE = '';

/** 注入存储根目录（必须在调用其它函数前执行一次） */
export function initImportStore({ userRoot }) {
  USER_ROOT = path.resolve(userRoot);
  META_FILE = path.join(USER_ROOT, '.maxbox-imports.json');
}

/** 确保存储目录存在 */
export function ensureUserRoot() {
  fs.mkdirSync(USER_ROOT, { recursive: true });
  return USER_ROOT;
}

/** 读取导入索引：{ [名称]: { source, importedAt, kind, files, size } } */
export function readMeta() {
  try {
    const parsed = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
    const items = parsed && parsed.items;
    return items && typeof items === 'object' ? items : {};
  } catch {
    return {};
  }
}

export function writeMeta(items) {
  try {
    ensureUserRoot();
    fs.writeFileSync(
      META_FILE,
      JSON.stringify({ version: 1, items }, null, 2),
      'utf8'
    );
  } catch (err) {
    console.error('写入导入索引失败：', err);
  }
}

/**
 * 统计目录内的文件数量与总字节数。
 * @returns {{files: number, size: number, truncated: boolean}}
 */
export function statFolder(dir) {
  let files = 0;
  let size = 0;
  let truncated = false;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue; // 无权限 / 已删除：跳过
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      files += 1;
      if (files > MAX_WALK_FILES) {
        truncated = true;
        break;
      }
      try {
        size += fs.statSync(full).size;
      } catch {
        /* 单个文件读不到大小不影响整体统计 */
      }
    }
    if (truncated) break;
  }
  return { files, size, truncated };
}

/** 目标名称去重：已存在则追加 -2 / -3 ... */
export function uniqueTargetName(name) {
  let candidate = name;
  let index = 2;
  while (fs.existsSync(path.join(USER_ROOT, candidate))) {
    candidate = `${name}-${index}`;
    index += 1;
  }
  return candidate;
}

/** 列出存储目录内已导入的全部内容（文件夹与单文件，最新在前） */
export function listImports() {
  ensureUserRoot();
  const meta = readMeta();
  const metaName = path.basename(META_FILE);
  let entries = [];
  try {
    entries = fs.readdirSync(USER_ROOT, { withFileTypes: true });
  } catch (err) {
    console.error('读取存储目录失败：', err);
    return [];
  }

  const items = [];
  for (const entry of entries) {
    // 跳过导入索引文件本身
    if (entry.name === metaName) continue;
    const target = path.join(USER_ROOT, entry.name);
    let stat = null;
    try {
      stat = fs.statSync(target);
    } catch {
      continue;
    }
    const isDir = stat.isDirectory();
    // 只处理常规文件与文件夹，跳过符号链接 / 设备文件等
    if (!isDir && !stat.isFile()) continue;

    const saved = meta[entry.name] || {};
    const kind = saved.kind || (isDir ? 'folder' : 'file');
    let files;
    let size;
    if (isDir) {
      // 索引里没有统计信息（例如手工拷进去的文件夹）时补算一次
      const computed =
        typeof saved.files === 'number' && typeof saved.size === 'number'
          ? null
          : statFolder(target);
      files = computed ? computed.files : saved.files;
      size = computed ? computed.size : saved.size;
    } else {
      files = 1;
      size = typeof saved.size === 'number' ? saved.size : stat.size;
    }
    items.push({
      name: entry.name,
      path: target,
      source: saved.source || '',
      importedAt: saved.importedAt || stat.birthtimeMs || stat.mtimeMs || 0,
      kind,
      files,
      size,
    });
  }
  items.sort((a, b) => (b.importedAt || 0) - (a.importedAt || 0));
  return items;
}

/**
 * 导入一个文件：把单个文件复制到存储目录下（同名自动加后缀），
 * 并在导入索引里记录来源、时间与大小。支持任意格式。
 */
export function importFile(sourcePath) {
  if (typeof sourcePath !== 'string' || sourcePath.trim() === '') {
    return { ok: false, error: '未提供要导入的文件路径。' };
  }
  const source = path.resolve(sourcePath);
  let stat = null;
  try {
    stat = fs.statSync(source);
  } catch {
    return { ok: false, error: '该文件不存在或无法访问。' };
  }
  if (!stat.isFile()) {
    return { ok: false, error: '请选择文件（不是文件夹）。' };
  }

  ensureUserRoot();
  const root = path.resolve(USER_ROOT);
  // 不允许把存储目录本身或其上层目录的导进自己（会自我递归复制）
  if (source === root || root.startsWith(source + path.sep)) {
    return { ok: false, error: '不能导入存储目录本身或其上层目录。' };
  }

  const baseName = path.basename(source) || 'file';
  const targetName = uniqueTargetName(baseName);
  const target = path.join(root, targetName);
  try {
    fs.copyFileSync(source, target);
  } catch (err) {
    console.error('复制文件失败：', err);
    return { ok: false, error: `复制文件失败：${err.message || err}` };
  }

  const item = {
    name: targetName,
    path: target,
    source,
    importedAt: Date.now(),
    kind: 'file',
    files: 1,
    size: stat.size,
  };

  const meta = readMeta();
  meta[targetName] = {
    source,
    importedAt: item.importedAt,
    kind: 'file',
    files: 1,
    size: stat.size,
  };
  writeMeta(meta);

  return { ok: true, item };
}

/**
 * 导入一个路径：自动识别是文件夹还是单个文件，再分别处理。
 * 用于拖拽等无法预先确定拖入内容类型的场景。
 */
export function importEntry(sourcePath) {
  if (typeof sourcePath !== 'string' || sourcePath.trim() === '') {
    return { ok: false, error: '未提供要导入的路径。' };
  }
  let stat = null;
  try {
    stat = fs.statSync(path.resolve(sourcePath));
  } catch {
    return { ok: false, error: '该路径不存在或无法访问。' };
  }
  if (stat.isDirectory()) return importFolder(sourcePath);
  if (stat.isFile()) return importFile(sourcePath);
  return { ok: false, error: '不支持的导入类型（既不是文件也不是文件夹）。' };
}

/**
 * 导入一个文件夹：把源目录整体复制到存储目录下（同名自动加后缀），
 * 并在导入索引里记录来源、时间与统计信息。
 */
export function importFolder(sourcePath) {
  if (typeof sourcePath !== 'string' || sourcePath.trim() === '') {
    return { ok: false, error: '未提供要导入的文件夹路径。' };
  }
  const source = path.resolve(sourcePath);
  let stat = null;
  try {
    stat = fs.statSync(source);
  } catch {
    return { ok: false, error: '该路径不存在或无法访问。' };
  }
  if (!stat.isDirectory()) {
    return { ok: false, error: '请选择文件夹（不是单个文件）。' };
  }

  ensureUserRoot();
  const root = path.resolve(USER_ROOT);
  // 不允许把存储目录本身或其上层目录导进来（会自我递归复制）
  if (source === root || root.startsWith(source + path.sep)) {
    return { ok: false, error: '不能导入存储目录本身或其上层目录。' };
  }

  const baseName = path.basename(source) || 'folder';
  const targetName = uniqueTargetName(baseName);
  const target = path.join(root, targetName);
  try {
    fs.cpSync(source, target, { recursive: true });
  } catch (err) {
    console.error('复制文件夹失败：', err);
    return { ok: false, error: `复制文件夹失败：${err.message || err}` };
  }

  const statResult = statFolder(target);
  const item = {
    name: targetName,
    path: target,
    source,
    importedAt: Date.now(),
    kind: 'folder',
    files: statResult.files,
    size: statResult.size,
    truncated: statResult.truncated,
  };

  const meta = readMeta();
  meta[targetName] = {
    source,
    importedAt: item.importedAt,
    kind: 'folder',
    files: item.files,
    size: item.size,
  };
  writeMeta(meta);

  return { ok: true, item };
}

/** 删除已导入的文件夹或文件（连带索引） */
export function removeImport(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    return { ok: false, error: '未提供要删除的名称。' };
  }
  // 只允许删除存储目录下的一级子项，杜绝 ../ 越权
  const target = path.resolve(USER_ROOT, name);
  const root = path.resolve(USER_ROOT);
  if (target === root || !target.startsWith(root + path.sep)) {
    return { ok: false, error: '非法路径。' };
  }
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (err) {
    console.error('删除失败：', err);
    return { ok: false, error: `删除失败：${err.message || err}` };
  }
  const meta = readMeta();
  delete meta[name];
  writeMeta(meta);
  return { ok: true, name };
}
