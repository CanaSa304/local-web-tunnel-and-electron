import { defineConfig } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      // 单页面入口：index.html（首页导入文件夹 + 我的）。
      // 原先的「装箱方案详情」详情页已随旧逻辑移除，不再需要多入口。
      input: {
        main: resolve(root, 'index.html'),
      },
    },
  },
});
