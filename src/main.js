import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  nativeTheme,
  ipcMain,
  shell,
  dialog,
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import started from 'electron-squirrel-startup';
import logoUrl from './logo.png';
import {
  initImportStore,
  listImports,
  importFolder,
  importFile,
  importEntry,
  removeImport,
} from './import-store.js';
import {
  PUBLISH_PORT,
  getPublishStatus,
  listPublishEntries,
  startPublish,
  stopPublish,
  switchPublishEntry,
} from '../kernel/index.js';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-accelerated-2d-canvas');

/* ==============================
 *  内容存储位置
 *  ---------------------------------------------
 *  首页导入的文件夹统一保存到项目根目录下的 user/ ：
 *    - 开发模式（electron-forge start）：<项目根>/user
 *    - 打包运行：<userData>/user（asar 只读，不能写进去）
 *  也可用环境变量 MAXBOX_USER_DIR 覆盖（便于测试 / 自定义位置）。
 * ============================== */
const USER_ROOT = process.env.MAXBOX_USER_DIR
  ? path.resolve(process.env.MAXBOX_USER_DIR)
  : app.isPackaged
    ? path.join(app.getPath('userData'), 'user')
    : path.join(app.getAppPath(), 'user');

// 导入存储相关逻辑（确保存储目录、复制文件夹 / 文件、维护索引、列出 / 删除）
// 已抽到 src/import-store.js，由 initImportStore 注入存储根目录 USER_ROOT。

/** 注册「导入文件夹 / 文件」相关的 IPC 处理器 */
function registerImportIpc() {
  // 存储目录路径（展示用）
  ipcMain.handle('import:get-root', () => USER_ROOT);

  // 弹出系统选择文件夹对话框，返回用户选中的路径（取消时返回 null）
  ipcMain.handle('import:choose-folder', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择要导入的文件夹',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  // 弹出系统选择文件对话框（不限格式），返回用户选中的路径（取消时返回 null）
  ipcMain.handle('import:choose-file', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择要导入的文件',
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  // 把指定路径的文件夹复制到存储目录
  ipcMain.handle('import:folder', (_event, sourcePath) => importFolder(sourcePath));

  // 把指定路径的单个文件复制到存储目录（不限格式）
  ipcMain.handle('import:file', (_event, sourcePath) => importFile(sourcePath));

  // 把指定路径导入存储目录：自动识别文件 / 文件夹
  ipcMain.handle('import:any', (_event, sourcePath) => importEntry(sourcePath));

  // 已导入列表
  ipcMain.handle('import:list', () => listImports());

  // 删除已导入的文件夹或文件
  ipcMain.handle('import:remove', (_event, name) => removeImport(name));

  // 在系统文件管理器中打开某个已导入文件夹或文件
  ipcMain.handle('import:open', (_event, name) => {
    if (typeof name !== 'string' || !name) return false;
    const target = path.resolve(USER_ROOT, name);
    if (!target.startsWith(path.resolve(USER_ROOT) + path.sep)) return false;
    shell.openPath(target);
    return true;
  });

  // 在系统文件管理器中打开存储目录
  ipcMain.handle('import:open-root', () => shell.openPath(USER_ROOT));
}

/**
 * 注册「HTML 公网转发」相关的 IPC 处理器：
 * 开启时启动 HTTP 服务并放行防火墙端口 5000，关闭时停服务并删除放行规则。
 */
function registerPublishIpc() {
  // 可发布的 HTML 条目（user/ 下的 html 文件、含 index.html 的文件夹）
  ipcMain.handle('publish:list', () => listPublishEntries(USER_ROOT));

  // 当前转发状态
  ipcMain.handle('publish:status', () => getPublishStatus());

  // 开启转发：开放防火墙端口 → 启动 HTTP 服务
  ipcMain.handle('publish:start', async (_event, options = {}) => {
    const entryName = options && options.entryName ? options.entryName : null;
    return startPublish({ rootDir: USER_ROOT, port: PUBLISH_PORT, entryName });
  });

  // 停止转发：停服务 → 关闭防火墙端口
  ipcMain.handle('publish:stop', () => stopPublish());

  // 服务运行中切换发布内容
  ipcMain.handle('publish:switch', async (_event, options = {}) => {
    const entryName = options && options.entryName ? options.entryName : null;
    return switchPublishEntry({ rootDir: USER_ROOT, entryName });
  });

  // 在系统默认浏览器里打开访问地址（只允许 http/https，避免打开任意本地程序）
  ipcMain.handle('publish:open', (_event, url) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
    shell.openExternal(url);
    return true;
  });
}

const createWindow = () => {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    // 白色标题栏：隐藏原生标题栏，用白色窗口控件覆盖层（Windows）
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#ffffff',
      symbolColor: '#000000',
      height: 32,
    },
    backgroundColor: '#ffffff',
    icon: logoUrl.startsWith('data:')
      ? nativeImage.createFromDataURL(logoUrl)
      : nativeImage.createFromPath(path.resolve(__dirname, logoUrl)),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  // 仅开发模式（electron-forge start）自动打开 DevTools；打包版（release）不自动打开。
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools();
  }

  // release 版屏蔽呼出 DevTools 的默认快捷键（F12 / Ctrl+Shift+I|J|C / Cmd+Alt+I），
  // 避免最终用户意外打开开发者工具；开发模式下保留以便调试。
  if (app.isPackaged) {
    mainWindow.webContents.on('before-input-event', (_event, input) => {
      const { type, key, control, shift, alt, meta } = input;
      if (type !== 'keyDown') return;
      const isDevToolsShortcut =
        key === 'F12' ||
        (control && shift && (key === 'I' || key === 'J' || key === 'C')) ||
        (meta && alt && key === 'I');
      if (isDevToolsShortcut) {
        _event.preventDefault();
      }
    });
  }
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // 强制浅色主题，使标题栏背景为白色
  nativeTheme.themeSource = 'light';

  // Remove the default application menu bar (File, Edit, View, Window, ...).
  Menu.setApplicationMenu(null);

  // 注册「导入文件夹 / 文件」IPC
  initImportStore({ userRoot: USER_ROOT });
  registerImportIpc();
  // 注册「HTML 公网转发」IPC
  registerPublishIpc();

  createWindow();

  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// 退出前自动停止 HTML 转发并删除防火墙放行规则，避免端口对外一直敞开
let quitting = false;
app.on('before-quit', (event) => {
  if (quitting) return;
  if (!getPublishStatus().running) return;
  event.preventDefault();
  quitting = true;
  stopPublish()
    .catch((err) => console.error('停止 HTML 转发失败：', err))
    .finally(() => app.quit());
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
