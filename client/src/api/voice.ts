/**
 * ============================================================
 * 类型化 API 层 - 语音房间（/api/voice）
 * ============================================================
 * 房间 CRUD 与 ICE 配置；实时信令走 /api/voice/ws（voice/VoiceSession.ts）
 */

import api from './http';
import { getRoomOwnerToken } from '../voice/roomOwnership';
import type { ChessMove } from '@k/shared';
import type { VoiceChatMessage, VoiceRoom } from '../types';

/**
 * 访客房间所有权令牌的请求头。
 * 放请求头而不是查询串：URL 会进 nginx access log（语音 WS 的 JWT 就是踩过这个坑）。
 */
function ownerTokenHeader(roomId: number): Record<string, string> {
  const token = getRoomOwnerToken(roomId);
  return token ? { 'X-Voice-Owner-Token': token } : {};
}

/** 房间列表（含实时在线人数，有人的排前） */
export function listVoiceRooms(): Promise<{ rooms: VoiceRoom[] }> {
  return api.get('/voice/rooms').then((r) => r.data);
}

/**
 * 创建房间（所有登录用户可创建）。
 * 访客创建时服务端会签发**所有权令牌**（`ownerToken`，只在这一个响应里回一次），
 * 调用方需要保存它（见 voice/roomOwnership.saveRoomOwnerToken）。
 */
export function createVoiceRoom(
  name: string,
  description?: string
): Promise<{ room: VoiceRoom; ownerToken?: string }> {
  return api.post('/voice/rooms', { name, description }).then((r) => r.data);
}

/**
 * 删除房间（创建者或管理员）。
 * 访客的房间需要带上所有权令牌 —— 这里从本地令牌表取（与 http.ts 从 localStorage
 * 取 k_token 同一套做法：凭证在 API 层统一附加，组件不必层层透传）。
 */
export function deleteVoiceRoom(roomId: number): Promise<{ success: boolean }> {
  return api.delete(`/voice/rooms/${roomId}`, { headers: ownerTokenHeader(roomId) }).then((r) => r.data);
}

/** WebRTC ICE 服务器配置（STUN / 可选 TURN） */
export function getVoiceIceServers(): Promise<RTCIceServer[]> {
  return api.get('/voice/ice').then((r) => r.data.iceServers as RTCIceServer[]);
}

/**
 * 换取一次性语音连接票据（登录用户）。
 *
 * 浏览器 WebSocket 无法自定义请求头，直接把 JWT 放进 `?token=` 会进
 * nginx access log 等渠道；因此改为「Bearer 换 30 秒票据 → `?ticket=` 建连」。
 * 票据只能用一次，所以**每次建连（含自动重连）都要重新换一张**。
 */
export function fetchVoiceTicket(): Promise<{ ticket: string }> {
  return api.post('/voice/ticket').then((r) => r.data);
}

/** 聊天记录分页参数（before_id 向更早翻、after_id 向更新翻；limit 默认 50 上限 100） */
export interface VoiceMessagesQuery {
  beforeId?: number;
  afterId?: number;
  limit?: number;
}

/** 拉取房间聊天记录（首次/补拉增量用 afterId，向上翻页用 beforeId） */
export function getVoiceRoomMessages(
  roomId: number,
  query: VoiceMessagesQuery = {}
): Promise<{ messages: VoiceChatMessage[]; has_more: boolean }> {
  const params: Record<string, string> = {};
  if (query.beforeId !== undefined) params.before_id = String(query.beforeId);
  if (query.afterId !== undefined) params.after_id = String(query.afterId);
  if (query.limit !== undefined) params.limit = String(query.limit);
  return api.get(`/voice/rooms/${roomId}/messages`, { params }).then((r) => r.data);
}

/** 清空房间聊天记录（房间创建者或管理员；访客房间同样带所有权令牌） */
export function clearVoiceRoomMessages(roomId: number): Promise<{ success: boolean }> {
  return api
    .delete(`/voice/rooms/${roomId}/messages`, { headers: ownerTokenHeader(roomId) })
    .then((r) => r.data);
}

// ---- 对战象棋：终局留档 / 战绩（复盘与战绩展示用） ----

/** 终局留档列表行（不含棋谱） */
export interface VoiceGameSummary {
  id: number;
  room_id: number;
  game_id: string;
  red_name: string;
  black_name: string;
  result: 'red-win' | 'black-win' | 'draw';
  reason: string;
  move_count: number;
  started_at: string;
  ended_at: string;
}

/** 单局复盘数据（含棋谱与中文记谱） */
export interface VoiceGameDetail extends VoiceGameSummary {
  red_user_id: number;
  black_user_id: number;
  moves: ChessMove[];
  notations: string[];
}

/** 用户象棋战绩（跨房间聚合） */
export interface ChessUserStats {
  wins: number;
  losses: number;
  draws: number;
  total: number;
}

/** 房间终局留档列表（before_id 向更早翻页） */
export function listRoomGames(
  roomId: number,
  beforeId?: number
): Promise<{ games: VoiceGameSummary[]; has_more: boolean }> {
  return api
    .get(`/voice/rooms/${roomId}/games`, { params: beforeId !== undefined ? { before_id: beforeId } : {} })
    .then((r) => r.data);
}

/** 单局复盘数据 */
export function getRoomGame(roomId: number, gameId: string): Promise<{ game: VoiceGameDetail }> {
  return api.get(`/voice/rooms/${roomId}/games/${gameId}`).then((r) => r.data);
}

/** 用户象棋战绩 */
export function getChessStats(userId: number): Promise<{ stats: ChessUserStats }> {
  return api.get(`/voice/chess/stats/${userId}`).then((r) => r.data);
}
