import { defineConfig } from 'vite';

// https://vitejs.dev/config
// 主进程不再依赖 node:sqlite（历史记录逻辑已移除），无需额外声明 external。
export default defineConfig({});
