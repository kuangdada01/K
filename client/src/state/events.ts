/**
 * ============================================================
 * 全局事件总线（mitt）
 * ============================================================
 * 替代 EventContext（原文件名 CreateContext）中的"计数器自增当事件"模式。
 * 订阅方直接注册回调，不再 useEffect 对比前后值。
 *
 * 事件:
 * - post:created           帖子已创建（首页刷新信息流）
 * - badge:changed          未读角标变化（通知/私信/公告已读或新事件）
 *   payload: { source: 'notif' | 'msg' | 'ann'; count?: number }
 *   count 为该来源乐观已读条数（历史语义：msg 传实际条数，其余为 1）
 * - follow:changed         关注状态变化
 *   payload: 被关注的用户 ID
 */

import mitt from 'mitt';

export type AppEvents = {
  'post:created': import('../types').Post | void;
  'post:deleted': number;
  'post:updated': number;
  'post:like': { postId: number; liked: boolean; likeCount: number };
  'post:repost': { postId: number; reposted: boolean; repostCount: number };
  'post:bookmark': { postId: number; bookmarked: boolean };
  'post:comment': { postId: number; commentCount: number };
  'badge:changed': { source: 'notif' | 'msg' | 'ann'; count?: number };
  'follow:changed': number;
  // P6：音乐播放控制事件（PostDetail 等开视频时暂停/恢复音乐，无需整包消费 MusicContext）
  'music:pause': void;
  'music:resume': void;
};

export const events = mitt<AppEvents>();
