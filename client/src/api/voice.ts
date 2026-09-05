/**
 * ============================================================
 * 类型化 API 层 - 语音房间（/api/voice）
 * ============================================================
 * 房间 CRUD 与 ICE 配置；实时信令走 /api/voice/ws（voice/VoiceSession.ts）
 */

import api from './http';
import type { VoiceChatMessage, VoiceRoom } from '../types';

/** 房间列表（含实时在线人数，有人的排前） */
export function listVoiceRooms(): Promise<{ rooms: VoiceRoom[] }> {
  return api.get('/voice/rooms').then((r) => r.data);
}

/** 创建房间（所有登录用户可创建） */
export function createVoiceRoom(name: string, description?: string): Promise<{ room: VoiceRoom }> {
  return api.post('/voice/rooms', { name, description }).then((r) => r.data);
}

/** 删除房间（创建者或管理员） */
export function deleteVoiceRoom(roomId: number): Promise<{ success: boolean }> {
  return api.delete(`/voice/rooms/${roomId}`).then((r) => r.data);
}

/** WebRTC ICE 服务器配置（STUN / 可选 TURN） */
export function getVoiceIceServers(): Promise<RTCIceServer[]> {
  return api.get('/voice/ice').then((r) => r.data.iceServers as RTCIceServer[]);
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

/** 清空房间聊天记录（房间创建者或管理员） */
export function clearVoiceRoomMessages(roomId: number): Promise<{ success: boolean }> {
  return api.delete(`/voice/rooms/${roomId}/messages`).then((r) => r.data);
}
