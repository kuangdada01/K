/**
 * ============================================================
 * 离线推送分发（services/push.service）
 * ============================================================
 * 把"这条 SSE 事件"翻译成"给这台设备的通知栏消息"，交给 lib/oppo-push 发出去。
 *
 * ## 触发位置：`sse.ts` 的 notifyUser 里，**没有 Android 在线连接**时才调用
 *
 * 这是"两套传输不重复提醒"的关键口径（与方案一文档 §3 的接缝一致）：
 *  · App 在前台 → 有一条 `client=android` 的 SSE 连接 → 只走 SSE（页面自己刷新）；
 *  · App 退到后台 → 客户端主动断开 SSE（见 AppShell 的 ON_STOP）→ 服务端立刻
 *    看作"手机不在线" → 走 OPPO 推送，由系统推送服务展示（App 被杀也能弹）；
 *  · 只有网页端在线（手机不在线）→ 同样走推送（网页的在线状态不该压掉手机提醒）。
 *
 * ## 文案口径与 App 内通知保持一致
 *
 *  · 私信：标题 = 发送者昵称，正文 = 消息摘要（图片消息给 `[图片]` 占位）；
 *  · 互动：标题 = 触发者昵称，正文 = `评论了你的帖子：xxx` / `回复了你的评论：xxx`；
 *  · 公告：标题 = `新公告`，正文 = 公告标题。
 * 点击动作一律是"打开应用内页"的深链（`chat:<id>` / `post:<id>` / `messages`
 * / `announcements`），与通知栏本地通知、站内链接走**同一条解析路径**。
 *
 * ## 只推"值得提醒的事件"
 *
 * 私信的撤回/清除（`recalled` / `cleared`）是同步事件，不推；
 * 发给"自己"的私信事件（发送者的两端同步）不推；查不到数据的事件（如已被
 * 删除的公告）不推 —— 宁可少一条，不能推一条错话。
 */

import type { SseEvent } from '@k/shared/schemas';
import { env } from '../config';
import { logger } from '../lib/logger';
import { fetchInvalidRegistrationIds, isOppoPushConfigured, maskToken, sendUnicast } from '../lib/oppo-push';
import * as messageRepo from '../repositories/message.repo';
import * as notificationRepo from '../repositories/notification.repo';
import * as pushRepo from '../repositories/push.repo';

/** 点击推送后打开的 Activity（完整类名；debug 包的 applicationIdSuffix 不影响类名） */
const MAIN_ACTIVITY = 'top.kuangdada.k.nativeapp.MainActivity';

/** 一次分发的设备数上限（单账号正常远小于它；纯防御，避免异常数据把循环拉满） */
const MAX_DEVICES_PER_PUSH = 10;

/** 组装好的一条推送（未指定设备） */
interface ComposedPush {
  title: string;
  body: string;
  /** 站内深链（`chat:<id>` / `post:<id>` / `messages` / `announcements`） */
  deepLink: string;
}

/**
 * 事件 → 推送文案。返回 null 表示**这条事件不推送**（见文件头"只推值得提醒的事件"）。
 *
 * @param userId 这条事件要提醒的那个用户（notifyUser 的收件人）
 * @param event  服务端 SSE 判别联合事件（形状由 @k/shared 唯一决定）
 */
export function composePush(userId: number, event: SseEvent): ComposedPush | null {
  switch (event.type) {
    case 'message': {
      // 只推"别人发给我"的新消息；撤回/清除是静默同步事件
      if (event.to !== userId) return null;
      if (event.recalled != null || event.cleared) return null;

      // 摘要查询在 repo 层（A2：push.service 是全工程唯一例外，已收口）
      const row = messageRepo.latestReceivedMessage(event.from, userId);
      if (!row) return null;

      // 语音消息 content 为空（不带正文）—— 预览优先按媒体类型给可读摘要；
      // 已撤回的（行保留、内容清空）给系统文案，不要推出一个空正文
      const preview = row.recalled_at
        ? '[消息已撤回]'
        : row.audio_url
          ? '[语音]'
          : row.image_url
            ? '[图片]'
            : row.content.trim() || '[新消息]';
      // QQ 式计数标题（2026-10-11 反馈）：锁屏上应该是「昵称(N条新消息) + 最新一条」。
      // N = 来自该发送者的未读总数；>1 才带计数（单条消息带计数是噪音）。
      // 同一个人连发多条时不在这里叠卡：App 内通知靠同 id 覆盖，
      // 离线推送靠 pushForOffline 的合并窗口（见下方说明）。
      const unreadCount = messageRepo.countUnreadFrom(event.from, userId);
      const name = row.name || '新私信';
      return {
        title: unreadCount > 1 ? `${name}(${unreadCount}条新消息)` : name,
        body: preview,
        deepLink: `chat:${event.from}`,
      };
    }

    case 'notification': {
      // 互动通知：评论/回复。评论内容与昵称都不在事件里（事件只带定位 id），补一次查询
      const row = notificationRepo.getCommentWithAuthor(event.comment_id);
      if (!row) return null;

      const action = row.parent_id != null ? '回复了你的评论' : '评论了你的帖子';
      return {
        title: row.name || '新通知',
        body: `${action}：${row.content.trim()}`,
        deepLink: event.post_id > 0 ? `post:${event.post_id}` : 'messages',
      };
    }

    case 'announcement': {
      // 公告只推**定向发布**的那一条给目标用户；全体公告由 pushAnnouncementToAll 处理。
      // 查不到（已被删除）或不是定向给这个用户的，一律不推 —— 事件在删除时也会复用，
      // 靠"行是否存在"天然区分新旧。
      const row = notificationRepo.getAnnouncementTargeting(event.announcement_id);
      if (!row || row.target_user_id !== userId) return null;
      return {
        title: '新公告',
        body: row.title,
        deepLink: 'announcements',
      };
    }
  }
}

/** 深链 → OPPO `action_parameters`（JSON 字符串；App 侧按 deep_link extra 解析） */
function actionParametersFor(deepLink: string): string {
  return JSON.stringify({ deep_link: deepLink });
}

/** 把一条组装好的推送发给指定设备列表，返回（并清理）失效的 token */
async function sendToTokens(
  devices: pushRepo.PushDevice[],
  push: ComposedPush
): Promise<{
  sent: number;
  failed: number;
  invalid: number;
}> {
  let sent = 0;
  let failed = 0;
  const invalidTokens: string[] = [];

  for (const device of devices.slice(0, MAX_DEVICES_PER_PUSH)) {
    const result = await sendUnicast(device.token, {
      title: push.title,
      content: push.body,
      activityClassName: MAIN_ACTIVITY,
      actionParameters: actionParametersFor(push.deepLink),
      // 设备上报的通道（0.1.16+）；null 时交给 lib/oppo-push 回退默认通道（见那里的长注释）
      channelId: device.channelId ?? undefined,
    });
    if (result.ok) {
      sent += 1;
    } else if (result.invalidToken) {
      invalidTokens.push(device.token);
    } else {
      failed += 1;
    }
  }

  if (invalidTokens.length > 0) {
    // 系统判定失效（卸载/换机）：删掉，避免下次继续对着死 token 发
    const removed = pushRepo.deleteTokens(invalidTokens);
    logger.info({ removed, tokens: invalidTokens.map(maskToken) }, 'OPPO 推送：已清理失效注册 id');
  }
  return { sent, failed, invalid: invalidTokens.length };
}

// ------------------------------------------------------------------
// 私信离线推送的合并窗口（2026-10-11）
// ------------------------------------------------------------------

/**
 * 同一个人连发多条时，离线推送**不能一条一张卡**地叠在锁屏上（用户拿它与 QQ 对比：
 * QQ 是「极樂鬼(4条新消息) + 最新一条」一张卡）。做法是 (userId, senderId) 粒度的
 * **尾沿合并**：最后一条消息落地后再等 [MERGE_WINDOW_MS] 才推；期间一直有人发就顺延，
 * 最长 [MERGE_MAX_WAIT_MS] 必发一次（长聊也要每半分钟响一声，不能永远不响）。
 * 触发时重新走 composePush —— 查到的自然是最新消息与最新未读数，一次推一张卡。
 */
const MERGE_WINDOW_MS = 5_000;
const MERGE_MAX_WAIT_MS = 30_000;

interface PendingMessagePush {
  timer: NodeJS.Timeout;
  /** 本轮合并从这一刻起算（顺延是否超限用它判定） */
  firstAt: number;
  userId: number;
  event: Extract<SseEvent, { type: 'message' }>;
}

const pendingMessagePushes = new Map<string, PendingMessagePush>();

/**
 * Android 在线判定（由 sse.ts 在模块加载时注入）。
 *
 * 合并窗口触发时要**重新**判一次"人回没回来"——事件发生时不在线不代表 5 秒后还不在线；
 * 用户若已打开 App，SSE 早已把消息带到，再弹推送就是重复打扰。
 * 用注入而不是反向 import sse.ts：它已经 import 了本模块，反向引用会成环。
 */
let androidOnlineChecker: ((userId: number) => boolean) | null = null;

export function setAndroidOnlineChecker(fn: (userId: number) => boolean): void {
  androidOnlineChecker = fn;
}

/** 私信事件进合并窗口（互动/公告低频，不走这里，见 pushForOffline） */
function scheduleMessagePush(userId: number, event: Extract<SseEvent, { type: 'message' }>): void {
  // 不值得推的同步事件（发给自己的/撤回/清除）在进窗口前就拦下，免得白等一拍
  if (event.to !== userId) return;
  if (event.recalled != null || event.cleared) return;

  const key = `${userId}:${event.from}`;
  const existing = pendingMessagePushes.get(key);
  if (existing) {
    existing.event = event;
    if (Date.now() - existing.firstAt >= MERGE_MAX_WAIT_MS) {
      // 等满最大窗口：立即触发，不再顺延
      clearTimeout(existing.timer);
      fireMessagePush(key);
      return;
    }
    clearTimeout(existing.timer);
    existing.timer = setTimeout(fireMessagePush, MERGE_WINDOW_MS, key);
    existing.timer.unref();
    return;
  }
  const timer = setTimeout(fireMessagePush, MERGE_WINDOW_MS, key);
  timer.unref();
  pendingMessagePushes.set(key, { timer, firstAt: Date.now(), userId, event });
}

/** 合并窗口到期：查最新消息与未读数，把「昵称(N条新消息) + 最新一条」一次推出去 */
function fireMessagePush(key: string): void {
  const entry = pendingMessagePushes.get(key);
  if (!entry) return;
  pendingMessagePushes.delete(key);
  void (async () => {
    if (androidOnlineChecker?.(entry.userId)) return; // 人已回来，SSE 送达即可
    const push = composePush(entry.userId, entry.event);
    if (!push) return;
    const devices = pushRepo.listDevicesByUser(entry.userId);
    if (devices.length === 0) {
      logger.debug({ userId: entry.userId, type: entry.event.type }, 'OPPO 推送：该用户没有注册设备，跳过');
      return;
    }
    const { sent, failed, invalid } = await sendToTokens(devices, push);
    logger.info(
      { userId: entry.userId, type: entry.event.type, devices: devices.length, sent, failed, invalid },
      'OPPO 推送完成（离线补偿）'
    );
  })().catch((err) => {
    logger.warn(
      { userId: entry.userId, err: err instanceof Error ? err.message : String(err) },
      '合并私信的设备推送异常（已忽略）'
    );
  });
}

/**
 * 向一个用户的所有设备推送他"刚才错过"的那条事件。
 *
 * 由 sse.ts 在"没有 Android 在线连接"时调用（fire-and-forget，见调用点注释）。
 * 未配置 OPPO 推送 / 没有注册设备 / 事件不值得推时，安静地什么都不做。
 *
 * 私信事件先进合并窗口（见上方说明），其余事件保持即时。
 */
export async function pushForOffline(userId: number, event: SseEvent): Promise<void> {
  if (!isOppoPushConfigured()) return;
  if (event.type === 'message') {
    scheduleMessagePush(userId, event);
    return;
  }

  const push = composePush(userId, event);
  if (!push) return;

  const devices = pushRepo.listDevicesByUser(userId);
  if (devices.length === 0) {
    logger.debug({ userId, type: event.type }, 'OPPO 推送：该用户没有注册设备，跳过');
    return;
  }

  const { sent, failed, invalid } = await sendToTokens(devices, push);
  logger.info(
    { userId, type: event.type, devices: devices.length, sent, failed, invalid },
    'OPPO 推送完成（离线补偿）'
  );
}

/**
 * 全体公告的逐设备推送。
 *
 * 为什么不走 OPPO 的"广播推送"：广播面向**所有安装了本 App 且开着推送通道的设备**
 * （包括已退出登录、甚至不是我们用户的设备）—— 与"给所有登录用户发公告"的语义
 * 不符。这里改为遍历自己库里的注册设备逐台单推：退登会删 token、换人登录会换绑，
 * 因此"谁收到"永远与"谁是登录用户"一致。
 *
 * 传入的是公告 id；行已不存在（删除事件复用同一事件类型）时静默跳过。
 * `excludeUserIds` 是"App 正在前台"的用户（已收到 SSE），跳过它们的设备避免重复提醒。
 */
export async function pushAnnouncementToAll(
  announcementId: number,
  excludeUserIds: Set<number> = new Set()
): Promise<void> {
  if (!isOppoPushConfigured()) return;
  const row = notificationRepo.getAnnouncementTargeting(announcementId);
  if (!row) return;

  const devices = pushRepo.listAllDevices();
  if (devices.length === 0) return;

  // 跳过在线用户（同一用户的设备一起跳过：SSE 在线即"人已经看到了"），并按 token 去重
  const seen = new Set<string>();
  const targets: pushRepo.PushDevice[] = [];
  for (const d of devices) {
    if (excludeUserIds.has(d.userId) || seen.has(d.token)) continue;
    seen.add(d.token);
    targets.push({ token: d.token, channelId: d.channelId });
  }
  if (targets.length === 0) return;

  const result = await sendToTokens(targets, {
    title: '新公告',
    body: row.title,
    deepLink: 'announcements',
  });
  logger.info({ devices: targets.length, ...result }, 'OPPO 推送完成（全体公告）');
}

/**
 * 清理系统回执里已失效的注册 id（定时任务调用，见 server/index.ts）。
 * 拉取失败/未配置时静默返回。
 */
export async function cleanupInvalidTokens(): Promise<number> {
  const invalid = await fetchInvalidRegistrationIds();
  if (invalid.length === 0) return 0;
  const removed = pushRepo.deleteTokens(invalid);
  logger.info({ fetched: invalid.length, removed }, 'OPPO 推送：失效回执清理完成');
  return removed;
}

/**
 * 推送运行时的启动钩子（**必须由 server/index.ts 的 bootstrap 调用**，
 * 不能放模块顶层：那会让测试 import 时就碰真实 k.db / 起定时器）。
 *
 * 做两件事：打一条"是否启用"的启动日志（排障第一现场），
 * 以及起失效回执清理的定时器（启动 5 分钟后一次、之后每 24h；`unref` 不阻退出）。
 */
export function startPushRuntime(): void {
  if (!isOppoPushConfigured()) {
    logger.info('OPPO 推送未配置（OPPO_PUSH_APP_KEY / OPPO_PUSH_MASTER_SECRET 缺省），离线推送禁用');
    return;
  }
  logger.info({ appId: env.OPPO_PUSH_APP_ID ?? '(未配置)' }, 'OPPO 推送已启用');
  const run = () => {
    void cleanupInvalidTokens().catch(() => {
      /* 内部已记日志；这里只保证不冒泡 */
    });
  };
  setTimeout(run, 5 * 60 * 1000).unref();
  setInterval(run, 24 * 3600 * 1000).unref();
}
