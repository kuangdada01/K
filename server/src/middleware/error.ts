/**
 * ============================================================
 * 统一错误处理中间件
 * ============================================================
 * - AppError: 业务错误（携带 HTTP 状态码），路由中 throw 即可
 * - asyncHandler: 包装 async 路由处理器，异常自动交给 errorHandler
 * - errorHandler: 全局兜底，对外不泄露内部实现细节
 *
 * 迁移说明: 原各路由手写的
 *   catch (err) { console.error(err); res.status(500).json({ error: '服务器内部错误' }); }
 * 与本模块 errorHandler 的输出完全一致（日志 + 500 + 统一文案），
 * 因此用 asyncHandler 替换 try/catch 不改变任何对外行为。
 */

import { Request, Response, NextFunction, RequestHandler } from 'express';
import multer from 'multer';
import { logger } from '../lib/logger';

/** 业务错误：路由/service 中 throw new AppError(400, '消息') */
export class AppError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'AppError';
  }
}

/**
 * async 路由包装器
 * 用法: router.get('/x', authMiddleware, asyncHandler(async (req, res) => { ... }))
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/**
 * 全局错误处理中间件（挂在所有路由之后）
 * 分支与文案与历史版本保持一致，保证对外行为不变
 */
export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction): void {
  // 带状态码的业务错误（如 CORS 拒绝）
  if (err?.status) {
    res.status(err.status).json({ error: err.message });
    return;
  }

  // Multer 文件大小超限错误
  if (err?.code === 'LIMIT_FILE_SIZE') {
    res.status(400).json({ error: '文件过大，图片最大10MB，视频最大300MB' });
    return;
  }

  // Multer 文件类型/字段错误
  if (err instanceof multer.MulterError) {
    res.status(400).json({ error: `文件上传失败：${err.message}` });
    return;
  }

  // 上传文件类型过滤错误
  if (
    err?.message &&
    (err.message.includes('Only image files') ||
      err.message.includes('仅支持视频格式文件') ||
      err.message.includes('封面图片'))
  ) {
    res.status(400).json({ error: err.message });
    return;
  }

  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ error: '服务器内部错误' });
}
