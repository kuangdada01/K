/**
 * ============================================================
 * 推送设备仓库（push.repo）
 * ============================================================
 * `push_devices` 表的全部读写（表结构见 db/schema.ts）。
 *
 * 语义要点：
 *  · **token 是设备级、user_id 是绑定关系**：同一台设备换账号登录时，
 *    upsert 会把绑定改写为新用户（"最后一台设备归最后登录的账号"），
 *    这正是隐私上需要的行为 —— 旧账号不能再把消息推到别人手里的设备上；
 *  · **删除以 token 为准**（不按 user_id 强校验）：退出登录时客户端主动删；
 *    系统回执判定失效时服务端按 token 删。删不到不影响任何主流程。
 */

import { getDb, stmt } from '../db/connection';

/** 一台注册设备（推送时按它逐台发送；channelId 见 upsertDevice 注释） */
export interface PushDevice {
  token: string;
  /** 客户端上报的本机通知通道 id（未上报的老客户端为 null → 发送时回退默认值） */
  channelId: string | null;
}

/** 注册（或改写绑定）一台设备；重复上报同一 token 是幂等的 */
export function upsertDevice(input: {
  userId: number;
  provider: string;
  token: string;
  packageName?: string | null;
  /**
   * 本机「新消息」通知通道的当前 id（客户端 0.1.16+ 上报）。
   *
   * 注意 SQL 里的 **COALESCE**：旧版客户端（不带该字段）重新注册时会把参数传成 null，
   * 此时**保留库中已有值** —— 否则一次降级运行就会把精确通道抹回默认值，
   * 让"通道静默修复过（_g2）"的设备重新回到收不到推送的状态。
   */
  channelId?: string | null;
}): void {
  stmt(
    `
    INSERT INTO push_devices (user_id, provider, token, package_name, channel_id)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(provider, token) DO UPDATE SET
      user_id = excluded.user_id,
      package_name = excluded.package_name,
      channel_id = COALESCE(excluded.channel_id, push_devices.channel_id),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `
  ).run(input.userId, input.provider, input.token, input.packageName ?? null, input.channelId ?? null);
}

/** 该用户当前有效的推送 token（同一台设备只会有一条；多设备就有多条） */
export function listTokensByUser(userId: number, provider = 'oppo'): string[] {
  const rows = stmt('SELECT token FROM push_devices WHERE user_id = ? AND provider = ?').all(
    userId,
    provider
  ) as { token: string }[];
  return rows.map((r) => r.token);
}

/** 该用户的全部注册设备（含通道 id；离线推送发送用，见 services/push.service） */
export function listDevicesByUser(userId: number, provider = 'oppo'): PushDevice[] {
  return stmt(
    'SELECT token, channel_id AS channelId FROM push_devices WHERE user_id = ? AND provider = ?'
  ).all(userId, provider) as PushDevice[];
}

/** 删除指定 token（系统判定失效时调用；token 已是死数据，不校验归属） */
export function deleteTokens(tokens: string[], provider = 'oppo'): number {
  if (tokens.length === 0) return 0;
  const del = stmt('DELETE FROM push_devices WHERE provider = ? AND token = ?');
  let removed = 0;
  const tx = getDb().transaction(() => {
    for (const token of tokens) {
      removed += del.run(provider, token).changes;
    }
  });
  tx();
  return removed;
}

/**
 * 删除**归属指定用户**的 token（客户端主动解绑，如退出登录）。
 *
 * 比 [deleteTokens] 多一个 user_id 条件：解绑是"账号动作"，
 * 只能删自己名下的绑定 —— 换绑到别人名下的设备不受影响。
 */
export function deleteTokensForUser(userId: number, tokens: string[], provider = 'oppo'): number {
  if (tokens.length === 0) return 0;
  const del = stmt('DELETE FROM push_devices WHERE user_id = ? AND provider = ? AND token = ?');
  let removed = 0;
  const tx = getDb().transaction(() => {
    for (const token of tokens) {
      removed += del.run(userId, provider, token).changes;
    }
  });
  tx();
  return removed;
}

/** 全部注册设备（含归属用户与通道 id）：全体公告推送时用于排除"已在线"的用户 */
export function listAllDevices(
  provider = 'oppo'
): { userId: number; token: string; channelId: string | null }[] {
  const rows = stmt(
    'SELECT user_id AS userId, token, channel_id AS channelId FROM push_devices WHERE provider = ?'
  ).all(provider) as { userId: number; token: string; channelId: string | null }[];
  return rows;
}
