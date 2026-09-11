/**
 * ============================================================
 * 系统元信息路由（/api 下的健康检查与版本检测）
 * ============================================================
 * 从 app.ts 内联端点抽出，保持路径不变：
 * - GET /api/health       健康检查（含数据库探针）
 * - GET /api/app/version  App 更新检测
 */

import { Router } from 'express';
import { env } from '../config';
import { stmt } from '../db/connection';
import { logger } from '../lib/logger';

const router = Router();

/**
 * 数据库探针。
 *
 * 健康检查必须证明「数据面可用」而不只是「进程还在」：getDb() 是惰性代理
 * （db/index.ts:47-53），打开文件/WAL/建表/迁移的错误都要到第一次真实查询才暴露。
 * 若 /health 不碰数据库，k.db 损坏时探针照样返回 200，于是 Docker HEALTHCHECK、
 * CI 容器冒烟、部署后校验全部误判通过，进程永不重启，而所有数据接口持续 500。
 *
 * 顺带把「懒初始化」从第一个用户请求提前到第一次健康检查，启动问题更早暴露。
 *
 * @returns null 表示健康；否则返回失败原因（仅用于服务端日志，不下发给客户端）
 */
function probeDatabase(): string | null {
  try {
    const row = stmt('SELECT 1 AS ok').get() as { ok?: number } | undefined;
    return row?.ok === 1 ? null : '数据库探针返回异常结果';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * GET /api/health - 服务器健康检查
 * 用于监控服务是否正常运行
 *
 * 200: { status: 'ok' }      进程与数据库均可用
 * 503: { status: 'error' }   数据库不可用（响应体不泄露内部错误细节，原因只进日志）
 */
router.get('/health', (_req, res) => {
  const dbError = probeDatabase();
  if (dbError !== null) {
    logger.error({ err: dbError }, '健康检查失败：数据库不可用');
    res.status(503).json({ status: 'error', database: 'unavailable', timestamp: new Date().toISOString() });
    return;
  }
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
