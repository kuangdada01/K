/**
 * ============================================================
 * 共享 schema 片段（zod）
 * ============================================================
 * 前后端共用的基础校验片段，保证错误文案一致
 */

import { z } from 'zod';

/** 字符串数字转换（multipart 表单字段都是字符串） */
export const intCoerce = z.coerce.number().int().positive();

/** 常用 schema 片段 */
export const emailSchema = z.string().min(1, '请输入邮箱地址').email('邮箱格式不正确');
export const passwordSchema = z.string().min(6, '密码至少需要6个字符');
export const usernameSchema = z.string().min(3, '用户名需要3-30个字符').max(30, '用户名需要3-30个字符');

/** 分页查询参数（保持历史语义：非法/缺失 → 默认值） */
export const pageQuerySchema = z.coerce.number().int().positive().catch(1);
// P2 修复：limit 上限 50，防止 ?limit=1000000 一次拉全表压垮服务
export const limitQuerySchema = z.coerce.number().int().positive().max(50).catch(20);
