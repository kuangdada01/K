/**
 * ============================================================
 * 通知与深链的纯函数（lib/notifications）
 * ============================================================
 * 抽成纯函数的原因：这些映射是"业务规则"（谁能弹、弹什么、点进去去哪），
 * 塞在 hook 里就只能靠真机验证；放这里可以直接单测。
 * ============================================================
 */

/** 一条待投递的本地通知 */
export interface LocalNotification {
  /** 通知 id（同 tag 下覆盖同一条，避免刷屏） */
  id: number;
  title: string;
  body: string;
  /** 点击后要跳转的站内路径（HashRouter 语义，如 /post/12） */
  deeplink: string;
  /** 合并键：同一会话/同一类通知合成一条 */
  tag?: string;
}

/** 把时间戳折成 31 位正整数（Notification id 用） */
function idFromNow(): number {
  return Date.now() % 2_147_483_647;
}

/**
 * SSE 事件 → 本地通知；返回 null 表示**不该提醒**。
 *
 * 规则：
 * - `message`：只提醒**别人发给我**的（`to === 我的 id`）。自己其他端发出的回声（`from === 我`）
 *   如果也弹，用户会看到"自己给自己发消息"的通知；
 * - `notification`（评论/回复）：带上 post_id 便于点进去直达；
 * - `announcement`：公告，跳公告页；
 * - 其它事件类型一律不弹。
 */
export function notificationForSse(
  type: string,
  data: Record<string, unknown>,
  myUserId: number | null | undefined
): LocalNotification | null {
  if (type === 'message') {
    const from = typeof data.from === 'number' ? data.from : null;
    const to = typeof data.to === 'number' ? data.to : null;
    if (!myUserId || to !== myUserId) return null;
    return {
      id: idFromNow(),
      title: '新私信',
      body: '你收到一条新私信',
      deeplink: from !== null ? `/messages/${from}` : '/messages',
      tag: from !== null ? `msg-${from}` : 'msg',
    };
  }

  if (type === 'notification') {
    const postId = typeof data.post_id === 'number' ? data.post_id : null;
    return {
      id: idFromNow(),
      title: '新通知',
      body: '有人评论了你的帖子',
      deeplink: postId !== null ? `/post/${postId}` : '/messages',
      tag: 'notif',
    };
  }

  if (type === 'announcement') {
    return {
      id: idFromNow(),
      title: '新公告',
      body: '有新的公告发布',
      deeplink: '/announcements',
      tag: 'ann',
    };
  }

  return null;
}

/**
 * 分享进来的文本 → 站内路径。
 *
 * 只有**指向本站**的链接才导航（避免把任意 URL 当站内路由，导致 404 兜底回首页）；
 * 返回 null 表示不是本站链接，调用方自行处理（我们选择"复制 + 提示"）。
 */
export function parseSharedText(text: string, serverUrl: string): string | null {
  const match = text.match(/https?:\/\/[^\s"'<>]+/);
  if (!match) return null;
  let url: URL;
  try {
    url = new URL(match[0]);
  } catch {
    return null;
  }
  let expectedHost = '';
  try {
    expectedHost = serverUrl ? new URL(serverUrl).host : '';
  } catch {
    expectedHost = '';
  }
  if (!expectedHost || url.host !== expectedHost) return null;
  const path = `${url.pathname}${url.search}`;
  return path.startsWith('/') ? path : `/${path}`;
}

/** 统一深链路径形态（补前导斜杠；空路径回落首页） */
export function normalizeDeeplinkPath(path: string | null | undefined): string {
  if (!path) return '/';
  const trimmed = path.trim();
  if (!trimmed) return '/';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}
