import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // db/index.ts 已惰性化（测试注入 :memory: 库，真实 k.db 全程零接触），
    // 并行 worker 不再共享文件，恢复默认并行以缩短 CI 时长
    // JWT_SECRET 自 fail-fast 后为必填（config.ts envSchema），CI 无 .env，这里注入测试密钥
    env: {
      JWT_SECRET: 'vitest-jwt-secret-0123456789abcdef',
    },
  },
});
