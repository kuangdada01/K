import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // 各测试文件 import db/index.ts 会在真实 k.db 上执行建表/迁移写入，
    // 并行 worker 同时写同一文件触发 SQLITE_BUSY（CI 全新库必现），改为串行
    fileParallelism: false,
  },
});
