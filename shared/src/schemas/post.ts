/**
 * ============================================================
 * 帖子相关请求体 schema（/api/posts）
 * ============================================================
 */

import { z } from 'zod';

// ============================================================
// 长度上限（前后端共用；服务端 multipart 文本字段与 JSON 请求体都以此为准）
// ============================================================

/** 帖子标题最大长度 */
export const POST_TITLE_MAX_LEN = 100;
/** 帖子正文最大长度（与公告一致） */
export const POST_DESCRIPTION_MAX_LEN = 5000;
/** 评论内容最大长度 */
export const COMMENT_MAX_LEN = 1000;

/**
 * 帖子文本字段校验（multipart 表单里的 title/description）。
 * 只 safeParse 这两个字段——multipart 请求体的其余字段（keepImages/close_comments 等）
 * 不能走 validateBody 全量替换，需在路由内单独校验。
 */
export const postTextSchema = z.object({
  title: z.string().max(POST_TITLE_MAX_LEN, `标题最多${POST_TITLE_MAX_LEN}个字符`).default(''),
  description: z
    .string()
    .max(POST_DESCRIPTION_MAX_LEN, `正文最多${POST_DESCRIPTION_MAX_LEN}个字符`)
    .default(''),
});

/** 评论创建校验 */
export const commentSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, '评论内容不能为空')
    .max(COMMENT_MAX_LEN, `评论最多${COMMENT_MAX_LEN}个字符`),
  parentId: z.number().int().positive().nullish(),
});

/** 评论创建请求体类型 */
export type CommentBody = z.infer<typeof commentSchema>;
