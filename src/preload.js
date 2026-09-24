// Preload 脚本（沙箱化、contextIsolation 开启下运行）：
// 通过 contextBridge 仅向渲染进程暴露「导入文件夹 / 文件」相关的白名单 API，
// 内部用 ipcRenderer.invoke 与主进程（src/main.js）通信，
// 由主进程把文件夹或文件复制并保存到项目根目录下的 user/ 中。
// 不向页面暴露 Node.js / Electron 全局能力，也不开放任意 IPC 通道。
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('maxboxImport', {
  // 内容存储目录（user/）的绝对路径
  getRoot: () => ipcRenderer.invoke('import:get-root'),

  // 弹出系统「选择文件夹」对话框，返回选中的路径；取消返回 null
  chooseFolder: () => ipcRenderer.invoke('import:choose-folder'),

  // 弹出系统「选择文件」对话框（不限格式），返回选中的路径；取消返回 null
  chooseFile: () => ipcRenderer.invoke('import:choose-file'),

  // 导入指定路径的文件夹 → { ok, item } 或 { ok: false, error }
  import: (sourcePath) => ipcRenderer.invoke('import:folder', sourcePath),

  // 导入指定路径的单个文件（不限格式）→ { ok, item } 或 { ok: false, error }
  importFile: (sourcePath) => ipcRenderer.invoke('import:file', sourcePath),

  // 导入指定路径，由主进程自动识别是文件还是文件夹 → { ok, item } 或 { ok: false, error }
  importAny: (sourcePath) => ipcRenderer.invoke('import:any', sourcePath),

  // 已导入列表（文件夹与单文件）
  list: () => ipcRenderer.invoke('import:list'),

  // 删除已导入的文件夹或文件
  remove: (name) => ipcRenderer.invoke('import:remove', name),

  // 在系统文件管理器中打开某个已导入文件夹或文件
  open: (name) => ipcRenderer.invoke('import:open', name),

  // 在系统文件管理器中打开存储目录
  openRoot: () => ipcRenderer.invoke('import:open-root'),

  // 拖拽进来时，把 File 对象解析为磁盘绝对路径（拿不到时返回空串）
  resolvePath: (file) => {
    try {
      return (file && webUtils.getPathForFile(file)) || '';
    } catch {
      return '';
    }
  },
});

// 「HTML 公网转发」白名单 API：开启时主进程会启动 HTTP 服务并放行防火墙端口，
// 关闭时停服务并删除放行规则。渲染进程只发指令，不接触任何系统能力。
contextBridge.exposeInMainWorld('maxboxPublish', {
  // 可发布的 HTML 条目列表
  list: () => ipcRenderer.invoke('publish:list'),

  // 当前转发状态 → { running, port, urls, entry, ruleName }
  status: () => ipcRenderer.invoke('publish:status'),

  // 开启转发（可传 { entryName }）→ { ok, status, error }
  start: (options) => ipcRenderer.invoke('publish:start', options || {}),

  // 停止转发并关闭防火墙端口 → { ok, error }
  stop: () => ipcRenderer.invoke('publish:stop'),

  // 运行中切换发布内容（可传 { entryName }）
  switch: (options) => ipcRenderer.invoke('publish:switch', options || {}),

  // 在系统默认浏览器里打开访问地址
  open: (url) => ipcRenderer.invoke('publish:open', url),
});
