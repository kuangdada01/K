import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 移除 HTML 中 script/link 标签的 crossorigin 属性
// Capacitor Android WebView 中 crossorigin 会导致 ERR_CONNECTION_REFUSED
function removeCrossorigin() {
  return {
    name: 'remove-crossorigin',
    enforce: 'post' as const,
    transformIndexHtml(html: string) {
      return html.replace(/ crossorigin/g, '');
    },
  };
}

export default defineConfig({
  plugins: [react(), removeCrossorigin()],
  base: '/',
  // shared 是 file: 符号链接的 CJS 包（dist/index.js），Vite 默认把链接依赖当源码直出，
  // 浏览器无法执行 require 导致页面崩溃；强制走 esbuild 预构建转为 ESM
  optimizeDeps: {
    include: ['@k/shared'],
  },
  // 语音降噪 worklet（RNNoise WASM 内嵌的单文件模块）经 ?worker&url 导出为独立 bundle；
  // 必须用 ES 格式：AudioWorkletGlobalScope 可执行 ESM，且内嵌 wasm 胶水依赖 import.meta.url
  worker: {
    format: 'es',
  },
  build: {
    rollupOptions: {
      output: {
        // 手动分包：稳定第三方库独立缓存，业务代码变更不影响其缓存
        // （Vite 8 基于 Rolldown，需函数式 manualChunks）
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('lucide-react')) return 'icons';
          // MP3 编码器约 150KB，仅在停止录制转码时经动态 import 按需加载，须独立成块
          if (id.includes('@breezystack/lamejs')) return 'lamejs';
          // HEIC 解码 WASM（libheif-js，约 1.4MB），仅选到 HEIC 图时经动态 import 按需加载，须独立成块
          if (id.includes('libheif')) return 'heic-decoder';
          if (
            id.includes('react-router') ||
            id.includes('/react/') ||
            id.includes('react-dom') ||
            id.includes('scheduler')
          )
            return 'react';
          if (id.includes('@tanstack')) return 'query';
          if (id.includes('axios')) return 'http';
          return 'vendor';
        },
      },
    },
  },
  server: {
    port: 5173,
    watch: {
      // 忽略编辑器原子保存产生的临时目录/文件（.*.tmpdir/、*.tmp）：
      // Windows 上 fs.watch 监听这些瞬态路径会报 EBUSY，导致 Vite 直接崩溃退出
      ignored: (path: string) =>
        path.includes('.tmpdir') || path.endsWith('.tmp') || path.endsWith('.tmpdir'),
    },
    proxy: {
      // 语音信令 WebSocket（需 ws:true 启用 upgrade 转发，须放在通用 /api 之前）
      '/api/voice/ws': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        ws: true,
      },
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/uploads': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
