/**
 * ============================================================
 * 推送设备注册路由（/api/push，2026-10-08）
 * ============================================================
 * 客户端（安卓原生版）在 OPPO SDK 注册成功后上报 registration_id，
 * 退出登录时删除绑定。服务端在"用户没有 Android 在线连接"时按这些
 * token 发离线推送（见 sse.ts / services/push.service）。
 *
 * API 端点:
 * - POST   /api/push/devices   - 注册/改写设备绑定（幂等，upsert）
 * - DELETE /api/push/devices   - 解除绑定（退出登录时调用）
 *
 * 认证: 必须（authMiddleware）——token 与用户绑定关系是私密数据，
 * 未登录不允许写。删除以 (provider, token) 为准：同一台设备换账号登录时
 * 注册会把绑定改到新账号名下，旧账号不能在退出后继续收到推送。
 * ============================================================
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/error';
import { authMiddleware } from '../middleware/auth';
import { validateBody } from '../validate';
import * as pushRepo from '../repositories/push.repo';
import { logger } from '../lib/logger';

const router = Router();

/**
 * 注册/删除的参数形状。
 *
 * `provider` 当前只接受 'oppo'（枚举写死在 schema 里：将来新增小米/华为通道时
 * 在这里加枚举值即可，客户端与服务端不用改传输结构）。
 * `token` 长度做宽松上下界：OPPO registration_id 是 32 位 hex 或带
 * `CN_`/`OPPO_` 前缀的形态，8~256 覆盖全部合法取值并挡住空串/超长垃圾。
 */
const deviceRegisterSchema = z.object({
  provider: z.enum(['oppo']).default('oppo'),
  token: z.string().min(8).max(256),
  /** 上报时的 applicationId（debug 包带 .debug 后缀）；仅诊断用，不参与过滤 */
  package_name: z.string().max(120).optional(),
  /**
   * 本机「新消息」通知通道的当前 id（客户端 0.1.16+）。
   *
   * Android 9+ 的通知栏消息必须带 channel_id 且与设备上真实存在的通道一致，
   * 否则系统静默丢弃 —— 而通道 id 会因"静默修复"变成 `k_messages_v2_g2`，
   * 只有设备自己知道。长度给宽松上界（通道 id 是普通字符串）。
   */
  channel_id: z.string().min(1).max(120).optional(),
});

const deviceUnregisterSchema = z.object({
  provider: z.enum(['oppo']).default('oppo'),
  token: z.string().min(8).max(256),
});

/** POST /api/push/devices - 注册（或改写绑定）当前账号在这台设备上的推送 token */
router.post(
  '/devices',
  authMiddleware,
  validateBody(deviceRegisterSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { provider, token, package_name, channel_id } = req.body as z.infer<typeof deviceRegisterSchema>;
    pushRepo.upsertDevice({
      userId: req.user!.id,
      provider,
      token,
      packageName: package_name ?? null,
      channelId: channel_id ?? null,
    });
    logger.info(
      { userId: req.user!.id, provider, packageName: package_name ?? null, channelId: channel_id ?? null },
      '推送设备已注册'
    );
    res.json({ ok: true });
  })
);

/** DELETE /api/push/devices - 解除绑定（退出登录；删不到也算成功，幂等） */
router.delete(
  '/devices',
  authMiddleware,
  validateBody(deviceUnregisterSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { provider, token } = req.body as z.infer<typeof deviceUnregisterSchema>;
    // 只删**自己名下**的绑定：设备被换绑到别的账号后，本账号的解绑请求不会误删
    const removed = pushRepo.deleteTokensForUser(req.user!.id, [token], provider);
    logger.info({ userId: req.user!.id, provider, removed }, '推送设备已解除绑定');
    res.json({ ok: true });
  })
);

export default router;
