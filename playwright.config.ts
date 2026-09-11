/**
 * Playwright E2E 测试配置
 * - webServer: 构建全部包并在 3200 端口启动编译产物（独立端口，不打扰开发服务）
 * - 数据隔离：通过 DB_PATH 指向 e2e/.tmp/ 下的独立 SQLite 库文件，
 *   注册/发帖等写路径测试不会写入开发或生产 k.db；
 *   上传目录同样经 UPLOADS_DIR 隔离到 e2e/.tmp/uploads（见下方 env 注释）
 * - E3 修复：CI 已单独跑过 npm run build，设置 SKIP_BUILD=1 跳过 webServer 的重复构建；
 *   本地 npm run e2e 不设该变量，行为不变（构建 + 启动）。
 */

import { defineConfig } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { DB_PATH } from './e2e/db-path';

// 独立测试库目录：提前创建（better-sqlite3 不会自动建父目录）
const e2eTmpDir = path.join(__dirname, 'e2e', '.tmp');
fs.mkdirSync(e2eTmpDir, { recursive: true });

/**
 * 每轮开始前重置测试库与上传目录（**尽力而为**，不因失败中断整轮运行）。
 *
 * 库此前只增不减：注册/发帖用例每轮都往同一份库追加，任何依赖计数或总量的
 * 断言都会变成时间相关的不稳定用例。
 *
 * **为什么重置不在这里做，而在 `e2e/reset-tmp.mjs`（挂在 webServer 命令前）**：
 * 本文件会被**每个 worker 进程**再次求值，而 worker 是在 webServer 启动**之后**
 * 才起来的 —— 那时删除库文件在 Linux 上会成功（unlink 掉服务端正持有的 inode：
 * 服务端继续写已删除的文件，规格却新建一张空库），症状是
 * `SqliteError: no such table: verification_codes`；Windows 上因文件占用而删除
 * 失败，所以这个坑只在 Linux CI 上暴露（CI 曾因此连挂两轮）。挂到启动命令前，
 * 保证它只跑一次、且只在服务端启动之前。
 *
 * 也试过「每轮一个随机文件名」，但本文件被多进程求值，随 runId 变化的路径会让
 * 服务端与规格连到不同的库（实测出现两个 k-e2e-*.db），因此改为稳定文件名 + 重置。
 */
// 目录仍需提前创建（better-sqlite3 不会自动建父目录；reset-tmp.mjs 也会建）
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
    // reset-tmp.mjs 必须在**服务端进程之前**跑：它删除上一轮的测试库与上传目录，
    // 且只在这里执行一次（见文件顶部关于「为什么不在 config 顶层删」的说明）。
    command: process.env.SKIP_BUILD
      ? 'node e2e/reset-tmp.mjs && node server/dist/index.js'
      : 'node e2e/reset-tmp.mjs && npm run build && node server/dist/index.js',
    url: 'http://localhost:3200/api/health',
    /**
     * 复用 3200 上已有的服务必须**显式 opt-in**。
     *
     * 旧行为恒为 `true`：如果谁手工用 `PORT=3200` 起了一个「非 e2e 配置」的服务
     * （没有 DB_PATH / UPLOADS_DIR 隔离，连的是真实 `server/k.db`），Playwright 会
     * **静默复用**它 —— 于是 `write-path` 把注册/发帖/点赞写进真实库，而上层还以为
     * 「数据已隔离」。这类失败最坏：测试是绿的，坏的是数据。
     *
     * 默认改为不复用：端口被占时 Playwright 直接报错退出（响亮失败），
     * 而不是悄悄换一个数据库跑。确实需要复用（例如自己已经按 e2e 配置起了服务、
     * 想省一次构建）时显式打开：
     *   PowerShell:  $env:E2E_REUSE=1; npm run e2e
     */
    reuseExistingServer: process.env.E2E_REUSE === '1',
    timeout: 180_000,
    env: {
      PORT: '3200',
      NODE_ENV: 'test',
      DB_PATH,
      // 上传目录同样隔离到 e2e/.tmp/：此前 e2e 与开发/生产共用真实 uploads，
      // 落盘名由服务端生成（lib/upload.ts:24-29，客户端传的文件名会被丢弃），
      // 所以「文件带 e2e- 前缀」的说法不成立，e2e 产物与真实用户文件无法区分。
      UPLOADS_DIR: path.join(e2eTmpDir, 'uploads'),
      // JWT_SECRET 自 fail-fast 后为必填（CI 无 .env，webServer 显式注入）
      JWT_SECRET: 'e2e-jwt-secret-0123456789abcdef',
    },
  },
});
