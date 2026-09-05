/**
 * ============================================================
 * 请求参数校验工具（基于 zod）
 * ============================================================
 * 提供请求体校验中间件，校验失败返回 400 + 第一条错误信息
 * schema 片段统一来自 @k/shared（前后端唯一事实来源）
 */

import { Request, Response, NextFunction } from 'express';
import { ZodType } from 'zod';
import { safeDeleteUpload } from './lib/file';

/** 校验请求体，通过后把解析结果写回 req.body */
export function validateBody<T>(schema: ZodType<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      // multipart 请求中 multer 已把文件写入磁盘，校验失败时清理避免孤儿文件。
      // file.path 是 diskStorage 的落盘绝对路径（uploads / uploads_private 由各路由
      // 的 uploader 决定），直接按绝对路径删除，避免猜子目录删错位置
      const file = req.file;
      if (file?.path) {
        safeDeleteUpload(file.path);
      }
      const message = result.error.issues[0]?.message || '参数错误';
      res.status(400).json({ error: message });
      return;
    }
    req.body = result.data;
    next();
  };
}
