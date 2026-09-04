/**
 * ============================================================
 * 认证路由模块 (/api/auth)
 * ============================================================
 * 处理用户注册、登录和身份验证
 *
 * API 端点:
 * - POST /api/auth/send-code        - 发送邮箱验证码
 * - POST /api/auth/register         - 用户注册（需验证码）
 * - POST /api/auth/login            - 用户登录（邮箱+密码）
 * - POST /api/auth/forgot-password  - 发送密码重置验证码
 * - POST /api/auth/reset-password   - 通过验证码重置密码
 * - GET  /api/auth/me               - 获取当前登录用户信息（需认证）
 * ============================================================
 */

import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { authMiddleware, generateToken } from '../middleware/auth';
import { asyncHandler, AppError } from '../middleware/error';
import { logger } from '../lib/logger';
import { sendVerificationCode } from '../mailer';
import { validateBody } from '../validate';
import {
  sendCodeSchema, registerSchema, loginSchema, forgotPasswordSchema, resetPasswordSchema,
} from '@k/shared';
import * as authRepo from '../repositories/auth.repo';
import * as userRepo from '../repositories/user.repo';

const router = Router();

/** 生成6位数字验证码（crypto 随机，避免 Math.random 可预测） */
function generateVerificationCode(): string {
  return String(crypto.randomInt(100000, 1000000));
}

/** 登录/注册限流：15分钟最多10次，防止暴力破解 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '尝试次数过多，请15分钟后再试' },
});

/** 验证码发送限流：每小时最多5次，防止刷邮件 */
const codeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '验证码发送过于频繁，请稍后再试' },
});

/**
 * POST /api/auth/send-code - 发送邮箱验证码
 *
 * 请求体:
 * - email: 接收验证码的邮箱地址
 *
 * 限制:
 * - 同一邮箱 60 秒内不可重复发送
 * - 验证码有效期 10 分钟
 *
 * 成功响应 (200):
 * - message: "验证码已发送"
 *
 * 错误响应:
 * - 400: 邮箱格式错误 或 60秒内已发送
 * - 500: 邮件发送失败
 */
router.post('/send-code', codeLimiter, validateBody(sendCodeSchema), asyncHandler(async (req: Request, res: Response) => {
  const { email } = req.body;

  // 检查60秒内是否已发送过
  if (authRepo.hasRecentCode(email)) {
    throw new AppError(400, '发送过于频繁，请60秒后再试');
  }

  // 生成6位数字验证码
  const code = generateVerificationCode();
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  // 删除该邮箱旧的验证码，插入新的
  authRepo.saveVerificationCode(email, code, expires);

  // 发送邮件（注册验证码）；与历史行为一致：发送环节失败统一返回"验证码发送失败"
  try {
    await sendVerificationCode(email, code, 'register');
  } catch (err) {
    logger.error({ err }, '发送验证码失败');
    throw new AppError(500, '验证码发送失败');
  }

  res.json({ message: '验证码已发送至邮箱' });
}));

/**
 * POST /api/auth/register - 用户注册
 *
 * 请求体:
 * - username: 用户名（3-30个字符，唯一）
 * - email: 邮箱（唯一）
 * - password: 密码（至少6个字符）
 * - code: 邮箱验证码
 *
 * 错误响应:
 * - 400: 参数缺失/格式错误/验证码错误/用户名或邮箱已存在
 * - 500: 服务器错误
 */
router.post('/register', authLimiter, validateBody(registerSchema), asyncHandler(async (req: Request, res: Response) => {
  const { username, email, password, code } = req.body;

  // 校验验证码
  const record = authRepo.findValidCode(email, code);
  if (!record) {
    throw new AppError(400, '验证码错误或已过期');
  }

  // 检查用户名和邮箱是否已被注册
  const existing = authRepo.findUserByUsernameOrEmail(username, email);
  if (existing) {
    throw new AppError(400, '用户名或邮箱已被注册');
  }

  // 密码加密（bcrypt 异步，避免阻塞事件循环，salt rounds = 10）
  const passwordHash = await bcrypt.hash(password, 10);

  // 插入新用户（email_verified = 1，已验证）
  const user = authRepo.createUser(username, email, passwordHash);

  // 删除已使用的验证码
  authRepo.deleteVerificationCodes(email);

  // 生成 token
  const token = generateToken({ id: user.id, username: user.username, role: user.role, tv: user.token_version });

  res.status(201).json({ token, user });
}));

/**
 * POST /api/auth/login - 用户登录
 *
 * 请求体:
 * - email: 邮箱
 * - password: 密码
 *
 * 成功响应 (200):
 * - token: JWT 认证令牌（7天有效期）
 * - user: 用户信息对象（不含密码）
 *
 * 错误响应:
 * - 400: 参数缺失
 * - 401: 邮箱或密码错误
 */
router.post('/login', authLimiter, validateBody(loginSchema), asyncHandler(async (req: Request, res: Response) => {
  const { email, password } = req.body;

  // 根据邮箱查询用户
  const user = authRepo.findUserByEmail(email);
  if (!user) {
    throw new AppError(401, '邮箱或密码错误');
  }

  // 验证密码（异步，避免阻塞事件循环）
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    throw new AppError(401, '邮箱或密码错误');
  }

  // 生成 JWT token
  const token = generateToken({ id: user.id, username: user.username, role: user.role, tv: user.token_version });

  // 移除密码字段后返回用户信息
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- 刻意省略 password_hash 字段
  const { password_hash, ...userWithoutPassword } = user;

  res.json({ token, user: userWithoutPassword });
}));

/**
 * POST /api/auth/forgot-password - 发送密码重置验证码
 *
 * 请求体:
 * - email: 已注册的邮箱地址
 *
 * 成功响应 (200):
 * - message: "验证码已发送至邮箱"
 *
 * 错误响应:
 * - 400: 邮箱格式错误 或 60秒内已发送
 * - 404: 该邮箱未注册
 * - 500: 邮件发送失败
 */
router.post('/forgot-password', codeLimiter, validateBody(forgotPasswordSchema), asyncHandler(async (req: Request, res: Response) => {
  const { email } = req.body;

  // 检查邮箱是否已注册
  const user = authRepo.findUserByEmail(email);
  if (!user) {
    throw new AppError(404, '该邮箱未注册');
  }

  // 检查60秒内是否已发送过
  if (authRepo.hasRecentCode(email)) {
    throw new AppError(400, '发送过于频繁，请60秒后再试');
  }

  // 生成6位数字验证码
  const code = generateVerificationCode();
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  // 删除该邮箱旧的验证码，插入新的
  authRepo.saveVerificationCode(email, code, expires);

  // 发送邮件（重置密码验证码）；与历史行为一致：发送环节失败统一返回"验证码发送失败"
  try {
    await sendVerificationCode(email, code, 'reset');
  } catch (err) {
    logger.error({ err }, '发送验证码失败');
    throw new AppError(500, '验证码发送失败');
  }

  res.json({ message: '验证码已发送至邮箱' });
}));

/**
 * POST /api/auth/reset-password - 通过验证码重置密码
 *
 * 请求体:
 * - email: 邮箱地址
 * - code: 邮箱验证码
 * - password: 新密码（至少6个字符）
 *
 * 成功响应 (200):
 * - message: "密码重置成功"
 *
 * 错误响应:
 * - 400: 参数缺失/格式错误/验证码错误或已过期
 * - 404: 该邮箱未注册
 * - 500: 服务器错误
 */
router.post('/reset-password', authLimiter, validateBody(resetPasswordSchema), asyncHandler(async (req: Request, res: Response) => {
  const { email, code, password } = req.body;

  // 检查邮箱是否已注册
  const user = authRepo.findUserByEmail(email);
  if (!user) {
    throw new AppError(404, '该邮箱未注册');
  }

  // 校验验证码
  const record = authRepo.findValidCode(email, code);
  if (!record) {
    throw new AppError(400, '验证码错误或已过期');
  }

  // 加密新密码并更新
  const passwordHash = await bcrypt.hash(password, 10);
  authRepo.updateUserPassword(user.id, passwordHash);

  // 删除已使用的验证码
  authRepo.deleteVerificationCodes(email);

  res.json({ message: '密码重置成功' });
}));

/**
 * GET /api/auth/me - 获取当前用户信息
 *
 * 需要认证: 是（Bearer Token）
 *
 * 成功响应 (200):
 * - 用户信息对象（id, username, email, avatar, bio, role, created_at）
 *
 * 错误响应:
 * - 401: 未认证
 * - 404: 用户不存在
 */
router.get('/me', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const user = userRepo.getSafeUser(req.user!.id);
  if (!user) {
    throw new AppError(404, '用户不存在');
  }
  res.json(user);
}));

export default router;
