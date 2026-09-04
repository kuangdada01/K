/**
 * ============================================================
 * 帖子相关请求体 schema（/api/posts）
 * ============================================================
 */

import { z } from 'zod';

/** 评论创建校验 */
export const commentSchema = z.object({
  content: z.string().trim().min(1, '评论内容不能为空'),
  parentId: z.number().int().positive().nullish(),
});

/** 评论创建请求体类型 */
export type CommentBody = z.infer<typeof commentSchema>;
