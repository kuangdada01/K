import os from 'os';
import path from 'path';
import { defineConfig } from 'vitest/config';

/**
 * 每个 vitest worker 进程用独立的上传目录。
 *
 * 此前测试直接写真实的 server/uploads 与 server/uploads_private，
 * 且从不清理：实测 uploads_private 里累积了 34 个历次运行留下的
 * gc-*.jpg 孤儿，而这些目录正是 express.static 对外提供的内容。
 * 更糟的是并行 worker 共享同一目录，让「目录里还有没有残留文件」
 * 这类断言互相干扰（曾导致用例单独跑通过、整套跑失败）。
 *
 * 进程号天然按 worker 隔离（配置文件在每个 worker 内各求值一次），
 * 目录落在系统临时区，不污染仓库树。
 */
const uploadsRoot = path.join(os.tmpdir(), `k-vitest-uploads-${process.pid}`);

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // db/index.ts 已惰性化（测试注入 :memory: 库，真实 k.db 全程零接触），
    // 并行 worker 不再共享文件，恢复默认并行以缩短 CI 时长
    // JWT_SECRET 自 fail-fast 后为必填（config.ts envSchema），CI 无 .env，这里注入测试密钥
    env: {
      JWT_SECRET: 'vitest-jwt-secret-0123456789abcdef',
      UPLOADS_DIR: uploadsRoot,
    },
  },
});
