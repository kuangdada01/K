/**
 * ============================================================
 * 认证相关请求体 schema（/api/auth）
 * ============================================================
 */

import { z } from 'zod';
import { emailSchema, passwordSchema, usernameSchema } from './common';

/** 发送验证码请求体 */
export const sendCodeSchema = z.object({ email: emailSchema });

/** 注册请求体 */
export const registerSchema = z.object({
  username: usernameSchema,
  email: emailSchema,
  password: passwordSchema,
  code: z.string().min(1, '请填写验证码'),
});

/** 登录请求体 */
export const loginSchema = z.object({
  email: z.string({ error: '请输入邮箱和密码' }).min(1, '请输入邮箱和密码'),
  password: z.string({ error: '请输入邮箱和密码' }).min(1, '请输入邮箱和密码'),
});

/** 忘记密码请求体 */
export const forgotPasswordSchema = z.object({ email: emailSchema });

/** 重置密码请求体（邮箱+验证码+新密码） */
export const resetPasswordSchema = z.object({
  email: emailSchema,
  code: z.string().min(1, '请填写验证码'),
  password: passwordSchema,
});

/** 请求体类型导出 */
export type SendCodeBody = z.infer<typeof sendCodeSchema>;
export type RegisterBody = z.infer<typeof registerSchema>;
export type LoginBody = z.infer<typeof loginSchema>;
export type ForgotPasswordBody = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordBody = z.infer<typeof resetPasswordSchema>;
