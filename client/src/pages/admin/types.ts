/**
 * ============================================================
 * 管理后台 · 共享行类型（pages/admin）
 * ============================================================
 * AdminPage（状态编排）与三个 Tab（视图）共用的行类型。
 */

/** /admin/users 行 */
export interface AdminUser {
  id: number;
  username: string;
  email: string;
  avatar: string | null;
  bio: string;
  role: string;
  created_at: string;
  post_count: number;
  banned_until: string | null;
}

/** /admin/posts 行 */
export interface AdminPost {
  id: number;
  user_id: number;
  username: string;
  avatar: string | null;
  image_url: string;
  images: string[];
  description: string;
  created_at: string;
  video_url?: string | null;
  video_cover?: string | null;
}

/** /admin/announcements 行 */
export interface AdminAnnouncement {
  id: number;
  title: string;
  content: string;
  target_user_id: number | null;
  target_username: string | null;
  created_at: string;
}

/** /admin/reports 行（举报一条私信消息；字段见 server report.repo 的 AdminReportRow） */
export interface AdminReport {
  id: number;
  message_id: number;
  reporter_id: number;
  sender_id: number;
  reason: string;
  file_sha256: string | null;
  status: 'open' | 'resolved';
  created_at: string;
  resolved_at: string | null;
  resolved_by: number | null;
  /** JOIN 出的上下文（消息可能已被撤回，此时 content/file_name 为空） */
  reporter_name: string;
  sender_name: string;
  message_content: string | null;
  message_file_name: string | null;
  message_recalled_at: string | null;
}
