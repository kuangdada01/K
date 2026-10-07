/**
 * ============================================================
 * 通知与深链纯函数单测（lib/notifications）
 * ============================================================
 * 这些规则决定了"什么时候弹通知、点通知去哪"，在真机上很难穷举验证
 * （要两台设备、要切后台），所以在这里把边界钉死。
 * ============================================================
 */

import { describe, expect, it } from 'vitest';
import { normalizeDeeplinkPath, notificationForSse, parseSharedText } from './notifications';

const ME = 7;

describe('notificationForSse', () => {
  it('别人发给我的私信 → 弹，并带上对方会话', () => {
    const n = notificationForSse('message', { from: 42, to: ME }, ME);
    expect(n).toMatchObject({
      title: '新私信',
      deeplink: '/messages/42',
      tag: 'msg-42',
    });
  });

  it('我自己其他端发出的回声（to 是别人）→ 不弹', () => {
    expect(notificationForSse('message', { from: ME, to: 42 }, ME)).toBeNull();
  });

  it('未登录（无 id）→ 不弹', () => {
    expect(notificationForSse('message', { from: 42, to: ME }, null)).toBeNull();
  });

  it('评论通知 → 弹，并直达帖子', () => {
    expect(notificationForSse('notification', { comment_id: 3, post_id: 12 }, ME)).toMatchObject({
      title: '新通知',
      deeplink: '/post/12',
      tag: 'notif',
    });
  });

  it('评论通知缺 post_id → 退到消息页（不生成死链）', () => {
    expect(notificationForSse('notification', {}, ME)?.deeplink).toBe('/messages');
  });

  it('公告 → 弹，跳公告页', () => {
    expect(notificationForSse('announcement', { announcement_id: 1 }, ME)).toMatchObject({
      title: '新公告',
      deeplink: '/announcements',
    });
  });

  it('未知事件类型 → 不弹', () => {
    expect(notificationForSse('post:like', { postId: 1 }, ME)).toBeNull();
  });

  it('每次通知 id 都是正整数（Notification id 约束）', () => {
    const n = notificationForSse('announcement', {}, ME)!;
    expect(Number.isInteger(n.id)).toBe(true);
    expect(n.id).toBeGreaterThan(0);
  });
});

describe('parseSharedText', () => {
  const SERVER = 'https://www.kuangdada.top';

  it('本站链接 → 抽出站内路径（含 query）', () => {
    expect(parseSharedText(`${SERVER}/post/12`, SERVER)).toBe('/post/12');
    expect(parseSharedText(`看看这个 ${SERVER}/post/12?from=wx 哈哈`, SERVER)).toBe('/post/12?from=wx');
  });

  it('站外链接 → null（不能被当成站内路由，否则兜底回首页）', () => {
    expect(parseSharedText('https://evil.example.com/post/12', SERVER)).toBeNull();
  });

  it('纯文本 → null', () => {
    expect(parseSharedText('今天天气不错', SERVER)).toBeNull();
  });

  it('服务器地址缺失 → null（宁可不跳，也不跳错）', () => {
    expect(parseSharedText(`${SERVER}/post/12`, '')).toBeNull();
  });
});

describe('normalizeDeeplinkPath', () => {
  it('补前导斜杠', () => {
    expect(normalizeDeeplinkPath('post/12')).toBe('/post/12');
  });

  it('空/空白 → 首页', () => {
    expect(normalizeDeeplinkPath('')).toBe('/');
    expect(normalizeDeeplinkPath(null)).toBe('/');
    expect(normalizeDeeplinkPath('   ')).toBe('/');
  });

  it('已规范的路径原样返回', () => {
    expect(normalizeDeeplinkPath('/messages/42')).toBe('/messages/42');
  });
});
