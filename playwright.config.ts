/**
 * Playwright E2E 测试配置
 * - webServer: 构建全部包并在 3200 端口启动编译产物（独立端口，不打扰开发服务）
 * - 数据隔离：通过 DB_PATH 指向 e2e/.tmp/ 下的独立 SQLite 库文件，
 *   注册/发帖等写路径测试不会写入开发或生产 k.db（uploads 目录共享，文件带 e2e- 前缀）
 * - E3 修复：CI 已单独跑过 npm run build，设置 SKIP_BUILD=1 跳过 webServer 的重复构建；
 *   本地 npm run e2e 不设该变量，行为不变（构建 + 启动）。
 */

import { defineConfig } from '@playwright/test';
import path from 'path';
import fs from 'fs';

// 独立测试库目录：提前创建（better-sqlite3 不会自动建父目录）
const e2eTmpDir = path.join(__dirname, 'e2e', '.tmp');
fs.mkdirSync(e2eTmpDir, { recursive: true });

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  // 拖拽等时序敏感用例在 CI 慢机上更脆：CI 重试 1 次，本地 0 次（不掩盖真实问题）
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  use: {
    baseURL: 'http://localhost:3200',
    locale: 'zh-CN',
  },
  webServer: {
    command: process.env.SKIP_BUILD
      ? 'node server/dist/index.js'
      : 'npm run build && node server/dist/index.js',
    url: 'http://localhost:3200/api/health',
    reuseExistingServer: true,
    timeout: 180_000,
    env: {
      PORT: '3200',
      NODE_ENV: 'test',
      DB_PATH: path.join(e2eTmpDir, 'k-e2e.db'),
      // JWT_SECRET 自 fail-fast 后为必填（CI 无 .env，webServer 显式注入）
      JWT_SECRET: 'e2e-jwt-secret-0123456789abcdef',
    },
  },
});
