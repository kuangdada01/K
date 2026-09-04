/**
 * ============================================================
 * 系统元信息路由（/api 下的健康检查与版本检测）
 * ============================================================
 * 从 app.ts 内联端点抽出，保持路径不变：
 * - GET /api/health       健康检查
 * - GET /api/app/version  App 更新检测
 */

import { Router } from 'express';
import { env } from '../config';

const router = Router();

/**
 * GET /api/health - 服务器健康检查
 * 用于监控服务是否正常运行
 */
router.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * GET /api/app/version - App 更新检测
 * 返回最新版本信息（version/apkUrl/notes），未配置 APP_VERSION 时 version 为 null（无更新）
 */
router.get('/app/version', (_req, res) => {
  res.json({
    version: env.APP_VERSION ?? null,
    apkUrl: env.APP_APK_URL ?? null,
    notes: env.APP_UPDATE_NOTES ?? '',
  });
});

export default router;
