import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// 渲染进程构建：输出到 dist-renderer，与 electron/main.js 中 loadFile 的路径对齐
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src')
    }
  },
  server: {
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: 'dist-renderer',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false
  }
});
