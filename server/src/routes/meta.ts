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
import { optionalAuth } from '../middleware/auth';

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

/**
 * POST /api/notify-diag - 客户端「通知链路」自检上报（**只写日志，不落库**）
 *
 * 为什么需要它：Android 端的"收不到通知"在服务端只能看到结果（推送发送记录），
 * 看不到原因 —— 而原因全在客户端：推送注册成功没有、通知通道与系统开关是什么
 * 状态、声音与震动的实际取值。让 App 在切到后台时**主动上报一行**，
 * 与服务端日志按时间对齐，一眼就能定位是哪一环断了（2026-10 那轮
 * "杀 App 收不到推送"的排查主线索，见 docs/android-background-notify-plan.md §7）。
 *
 * 刻意做成可选鉴权 + 只写日志：
 *  · 未登录时也要能上报（问题可能就发生在登录态异常时）；
 *  · 不落库、不改任何业务状态 —— 唯一副作用是一行结构化日志，随时可删。
 * 写入频率天然受全局 /api 写限流（120 次/分钟/IP）约束。
 */
router.post('/notify-diag', optionalAuth, (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  // 只挑白名单字段，避免把客户端传来的任意内容整坨写进日志
  const pick = (k: string) => {
    const v = body[k];
    return typeof v === 'string' ? v.slice(0, 120) : v;
  };
  logger.info(
    {
      userId: req.user?.id ?? null,
      appVersion: pick('version'),
      // 厂商离线推送这条路的客户端侧状态（注册/上报结果）
      pushSupported: pick('pushSupported'),
      pushRegistered: pick('pushRegistered'),
      pushError: pick('pushError'),
      // 通道适配（Android 9+ 推送必须按这个 id 指定通道；0.1.16+ 上报）
      channelId: pick('channelId'),
      // 应用级通知开关 + 运行时权限（"通知能发但看不到"时的第一嫌疑层）
      notificationsEnabled: pick('notificationsEnabled'),
      notifPermission: pick('notifPermission'),
      // 声音/震动这条路的**实际取值**（静音模式、通知音量、渠道重要性/提示音/震动）
      ringerMode: pick('ringerMode'),
      notificationVolume: pick('notificationVolume'),
      channelImportance: pick('channelImportance'),
      channelSound: pick('channelSound'),
      channelVibrate: pick('channelVibrate'),
    },
    '客户端通知诊断'
  );
  res.json({ ok: true });
});

export default router;
