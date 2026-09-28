import { defineConfig } from 'vitest/config';

// shared 无 DOM 依赖（引擎为纯函数 + zod schema），node 环境即可；
// 测试与源码同目录（*.test.ts），与 server/client 的惯例一致。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
