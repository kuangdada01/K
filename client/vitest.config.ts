import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// 独立于 vite.config.ts：构建配置含 rolldown 分包/代理等生产关注点，
// 测试配置只需 jsdom 环境 + setup；test 文件与源码同目录（*.test.tsx）
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
