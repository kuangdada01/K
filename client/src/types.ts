/**
 * ============================================================
 * K 前端类型定义
 * ============================================================
 * 领域类型统一来自 @k/shared（前后端唯一事实来源），
 * 此处只做再导出，保证既有 import '../types' 路径不变。
 */

export type {
  User,
  Announcement,
  Post,
  Comment,
  Notification,
  Message,
  Conversation,
  AuthResponse,
  SendCodeResponse,
  PaginatedResponse,
  BookSummary,
  BookChapter,
  BookVolume,
  BookDetail,
  VoiceRoom,
  VoiceParticipant,
  VoiceChatMessage,
} from '@k/shared';
