/**
 * ============================================================
 * 前后端共享领域类型定义
 * ============================================================
 * 与后端 API 返回的数据结构保持一致。
 * 客户端导入时使用 import type（类型在编译期擦除，无运行时依赖）。
 */

// ============================================================
// 用户相关类型
// ============================================================

/** 用户信息接口（对应后端 users 表结构） */
export interface User {
  id: number;
  username: string;
  email: string;
  avatar: string | null; // 头像文件路径
  bio: string; // 个人简介
  role?: string; // 角色: 'user' | 'admin'
  created_at: string; // 注册时间
  post_count?: number; // 帖子数量（仅在用户资料接口返回）
  followers_count?: number; // 粉丝数（仅在用户资料接口返回）
  following_count?: number; // 关注数（仅在用户资料接口返回）
}

// ============================================================
// 公告相关类型
// ============================================================

/** 公告信息接口（对应后端 announcements 表，扩展已读状态和关联用户信息） */
export interface Announcement {
  id: number;
  title: string; // 公告标题
  content: string; // 公告内容
  target_user_id: number | null; // 目标用户ID（null=全体公告）
  from_user_id: number; // 发布者ID
  created_at: string;
  from_username?: string; // 发布者用户名
  from_avatar?: string | null; // 发布者头像
  target_username?: string | null; // 目标用户名（定向公告时有值）
  is_read?: number; // 已读状态: 0=未读, 1=已读
}

// ============================================================
// 帖子相关类型
// ============================================================

/** 帖子信息接口（对应后端 posts 表，扩展图片数组、点赞数、评论数等） */
export interface Post {
  id: number;
  user_id: number;
  image_url: string; // 图片URL（JSON字符串格式）
  images: string[]; // 图片URL数组（前端解析后使用）
  title: string;
  description: string;
  created_at: string;
  username: string; // 发布者用户名
  avatar: string | null; // 发布者头像
  like_count: number; // 点赞数
  comment_count: number; // 评论数
  share_count: number; // 分享数
  liked?: number; // 当前用户是否已点赞: 0/1
  shared?: number; // 当前用户是否已分享: 0/1
  bookmarked?: number; // 当前用户是否已收藏: 0/1
  reposted?: number; // 当前用户是否已转发: 0/1
  repost_count?: number; // 转发数
  close_comments?: number; // 是否关闭评论: 0/1 (SQLite 返回数字)
  pinned?: number; // 是否置顶: 0/1
  video_url?: string | null; // 视频URL
  video_cover?: string | null; // 视频封面URL
}

// ============================================================
// 评论相关类型
// ============================================================

/** 评论信息接口（对应后端 comments 表，扩展点赞数、父评论信息等） */
export interface Comment {
  id: number;
  user_id: number;
  post_id: number;
  parent_id: number | null; // 父评论ID（null=顶级评论）
  content: string;
  created_at: string;
  username: string; // 评论者用户名
  avatar: string | null; // 评论者头像
  like_count: number; // 评论点赞数
  liked?: number; // 当前用户是否已点赞
  parent_content?: string | null; // 父评论内容（回复时显示）
  parent_username?: string | null; // 父评论用户名（回复时显示）
}

// ============================================================
// 通知相关类型
// ============================================================

/** 通知信息接口（对应后端 notifications 表） */
export interface Notification {
  id: number;
  user_id: number; // 接收通知的用户ID
  type: string; // 通知类型: 'reply' | 'comment'
  from_user_id: number; // 触发通知的用户ID
  post_id: number | null; // 相关帖子ID
  comment_id: number | null; // 相关评论ID
  content: string; // 通知内容摘要
  read: number; // 已读状态: 0=未读, 1=已读
  created_at: string;
  from_username: string; // 触发者用户名
  from_avatar: string | null; // 触发者头像
}

// ============================================================
// 私信相关类型
// ============================================================

/** 私信消息接口（对应后端 messages 表） */
export interface Message {
  id: number;
  sender_id: number;
  receiver_id: number;
  content: string; // 消息文字内容
  image_url?: string | null; // 消息图片URL
  read: number; // 已读状态: 0=未读, 1=已读
  created_at: string;
  sender_username: string; // 发送者用户名
  quoted_message_id?: number | null; // 被引用消息ID
  quoted_content?: string | null; // 被引用消息内容
  quoted_image_url?: string | null; // 被引用消息图片URL
  quoted_sender_username?: string | null; // 被引用消息发送者用户名
}

/** 会话接口（由后端聚合查询生成，包含对方用户信息和最后一条消息） */
export interface Conversation {
  partner_id: number; // 对方用户ID
  username: string; // 对方用户名
  avatar: string | null; // 对方头像
  last_message: string; // 最后一条消息内容
  last_message_at: string; // 最后消息时间
  unread_count: number; // 未读消息数
}

// ============================================================
// API 响应类型
// ============================================================

/** 认证响应接口（登录/注册成功时返回） */
export interface AuthResponse {
  token: string; // JWT 认证令牌
  user: User; // 用户信息
}

/** 发送验证码响应 */
export interface SendCodeResponse {
  message: string;
}

/** 分页响应接口（通用分页数据结构） */
export interface PaginatedResponse<T> {
  posts: T[]; // 数据列表
  total: number; // 总数量
  page: number; // 当前页码
  totalPages: number; // 总页数
}

// ============================================================
// 图书模块类型
// ============================================================

/** 图书列表项（/api/books） */
export interface BookSummary {
  id: string;
  title: string;
  author: string;
  description: string;
  cover: string | null;
  volumeCount: number;
  chapterCount: number;
}

/** 章节（文件） */
export interface BookChapter {
  file: string;
  type: 'text' | 'pdf';
  title: string;
}

/** 卷（目录） */
export interface BookVolume {
  name: string;
  chapters: BookChapter[];
}

/** 图书详情（/api/books/:id） */
export interface BookDetail extends BookSummary {
  volumes: BookVolume[];
}

// ============================================================
// 语音房间模块类型
// ============================================================

/** 语音房间（对应后端 voice_rooms 表，participantCount 来自 WS 内存态实时统计） */
export interface VoiceRoom {
  id: number;
  name: string; // 房间名
  description: string; // 房间简介
  creator_id: number; // 创建者用户ID（未登录访客创建为 0 占位，不做相等判断，归属以 isCreator 为准）
  created_at: string;
  creator_username?: string; // 创建者用户名快照（访客创建为"未登录-N"，改名后不变）
  creator_avatar?: string | null; // 创建者头像快照（创建时记录）
  participantCount?: number; // 当前在线人数（REST 列表接口返回）
  isCreator?: boolean; // 当前查看者是否是本房间创建者（REST 列表按请求方计算，用于显示删除/清聊入口）
}

/** 语音房间在线参与者（WS room-state / peer-joined 消息携带） */
export interface VoiceParticipant {
  userId: number;
  username: string;
  avatar: string | null;
  muted: boolean; // 是否关闭麦克风（听者模式同样为 true）
  listener: boolean; // 无麦克风权限、仅收听的成员
  sharing?: boolean; // 正在共享屏幕（同一时刻全房间最多一人，服务端互斥保证）
}

/** 语音房间文字聊天消息（对应后端 voice_room_messages 表；文本走信令 WS 实时收发，作为语音不良时的备用交流通道） */
export interface VoiceChatMessage {
  id: number;
  room_id: number; // 所属房间
  sender_id: number; // 发送者用户ID（未登录访客为负数）
  username: string; // 发送时刻的用户名快照（改名后历史消息显示不变；访客为"未登录-N"）
  avatar: string | null; // 发送时刻的头像快照
  content: string; // 纯文本内容（≤500 字符，服务端入库前已剔除控制字符）
  created_at: string;
}
