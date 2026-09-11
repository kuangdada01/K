/**
 * ============================================================
 * 语音连接票据（voice/tickets）
 * ============================================================
 * 浏览器 WebSocket 无法自定义请求头，因此语音信令此前把 JWT 放在
 * `/api/voice/ws?token=<JWT>` 的查询串里 —— 它会进 nginx access log
 * （SSE 早已改为一次性票据，语音一直没跟上）。现在对齐：
 *
 * - 客户端先用 `POST /api/voice/ticket`（Bearer）换一张 30 秒票据，
 *   再以 `/api/voice/ws?ticket=<票据>` 建连
 * - **兼容**：旧客户端（已发布的 APK 0.2.37、缓存网页）仍可 `?token=` 直连，
 *   但会在服务端留下一条 deprecation 日志，便于判断何时可以下线这条路径
 *
 * 与 SSE 各用独立实例：票据不跨协议通用（见 lib/oneTimeTicket 说明）。
 * ============================================================
 */

import { createOneTimeTicketStore } from '../lib/oneTimeTicket';

/** 语音连接票据存储（内存态，重启即失效） */
export const voiceTickets = createOneTimeTicketStore();
