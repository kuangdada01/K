/**
 * ============================================================
 * 管理后台请求体 schema（/api/admin）
 * ============================================================
 */

import { z } from 'zod';
import { intCoerce, passwordSchema } from './common';

/** 公告创建校验 */
export const announcementSchema = z.object({
  title: z.string().trim().min(1, '请填写标题').max(200, '标题最多200个字符'),
  content: z.string().trim().min(1, '请填写内容').max(5000, '内容最多5000个字符'),
  target_user_id: intCoerce.optional().nullable(),
});

/** 管理员重置用户密码校验 */
export const adminResetPasswordSchema = z.object({ password: passwordSchema });

/** 请求体类型导出 */
export type AnnouncementBody = z.infer<typeof announcementSchema>;
export type AdminResetPasswordBody = z.infer<typeof adminResetPasswordSchema>;
