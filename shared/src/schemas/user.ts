/**
 * ============================================================
 * 用户资料请求体 schema（/api/users）
 * ============================================================
 */

import { z } from 'zod';

/** 更新资料校验 */
export const updateProfileSchema = z.object({
  username: z.string().trim().min(1, '用户名需要1-30个字符').max(30, '用户名需要1-30个字符').optional(),
  bio: z.string().max(500, '简介最多500个字符').optional(),
});

/** 更新资料请求体类型 */
export type UpdateProfileBody = z.infer<typeof updateProfileSchema>;
