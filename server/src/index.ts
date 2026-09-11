/**
 * ============================================================
 * K 服务器入口文件
 * ============================================================
 * 仅负责 bootstrap:
 * 1. 加载 .env
 * 2. 创建 Express 应用（app.ts 组装中间件与路由）
 * 3. 启动 HTTP 服务器（默认端口 3000）
 */

import dotenv from 'dotenv';
import path from 'path';

// 加载 .env 文件（从项目根目录）。
// override: true —— .env 为准，压掉 PM2 进程环境里残留的上一版旧值
// （dotenv 默认不覆盖已存在变量，否则发版后新 .env 会被静默忽略；详见 config.ts）
dotenv.config({ path: path.join(__dirname, '..', '..', '.env'), override: true });

import { env } from './config';
import { createApp } from './app';
import { attachVoiceWs } from './voice/ws';
import { closeAllStreams } from './sse';
import { logger } from './lib/logger';

const PORT = env.PORT;
const app = createApp();

const server = app.listen(PORT, () => {
  logger.info(`K server running on http://localhost:${PORT}`);
});

// 语音房间信令 WebSocket（挂到同一 HTTP 服务器，路径 /api/voice/ws）
const wss = attachVoiceWs(server);

// 大视频上传 + ffmpeg 转码可能耗时较长，禁用请求超时（Node 默认 5 分钟；
// 前置 nginx 有自己的超时兜底）
server.requestTimeout = 0;
// headersTimeout 保持 Node 默认 60s（不置 0）：此前与 requestTimeout 一并置 0
// 会让慢速 HTTP 头攻击（slowloris 类）没有超时上限，连接期无限占用；
// requestTimeout = 0 已覆盖大视频上传场景，headersTimeout 独立控制头部接收窗口

// 优雅停机：PM2 reload/stop 发 SIGTERM——停止接新连接、断开长连接、等存量请求收尾
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, '收到停机信号，开始优雅关闭');
  // 语音 WS 客户端全部断开（1001 Going Away），否则 server.close() 等不到排空
  for (const client of wss.clients) client.close(1001, 'server shutting down');
  wss.close();
  // SSE 是长连接，主动 end 才能让 server.close() 的回调触发
  closeAllStreams();
  server.close(() => {
    logger.info('HTTP 服务器已关闭，进程退出');
    process.exit(0);
  });
  // 兜底：存量请求迟迟不结束（如大文件上传中）时按时退出，避免拖死 PM2 重启
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
