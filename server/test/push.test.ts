/**
 * ============================================================
 * OPPO 离线推送 单测（2026-10-08 接入）
 * ============================================================
 * 覆盖四块"写错就静默失效/隐私出错"的地方：
 *  A. 鉴权签名：sha256(appKey + timestamp + masterSecret) —— 格式错只会得到
 *     `code=16 Invalid Signature`，从日志上看不出算错了什么；
 *  B. 文案组装 composePush：哪些事件该推、哪些绝对不能推（撤回/清除/发给自己的
 *     同步事件/已删除的公告）—— 推错一条就是"说了错话"；
 *  C. 设备仓库：换账号登录时 token 绑定必须**改写**到新账号，解绑只能删自己的；
 *  D. HTTP 路由：/api/push/devices 的注册 / 解绑 / 鉴权 / 参数校验。
 *
 * 注：`notifyUser → 转推` 的判定在 `sse-push-fallback.test.ts`（mock 掉服务层）。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Database } from 'better-sqlite3';
import { createMemoryDb } from './helpers/memdb';
import { setDbForTests, resetDbForTests } from '../src/db/connection';
import { oppoAuthSign, clampChars, DEFAULT_PUSH_CHANNEL_ID } from '../src/lib/oppo-push';
import { composePush } from '../src/services/push.service';
import * as pushRepo from '../src/repositories/push.repo';
import { createApp } from '../src/app';
import { generateToken } from '../src/middleware/auth';

let db: Database;
let server: http.Server;
let base = '';
let aliceToken = '';
let bobToken = '';

const ALICE = 101;
const BOB = 102;

beforeAll(async () => {
  db = createMemoryDb();
  setDbForTests(db);
  db.prepare(
    "INSERT INTO users (id, username, email, password_hash) VALUES (?, 'alice', 'alice@test.dev', 'h')"
  ).run(ALICE);
  db.prepare(
    "INSERT INTO users (id, username, email, password_hash) VALUES (?, 'bob', 'bob@test.dev', 'h')"
  ).run(BOB);

  aliceToken = generateToken({ id: ALICE, username: 'alice' });
  bobToken = generateToken({ id: BOB, username: 'bob' });

  // 路由测试走真实 HTTP（与 authz-hardening.test.ts 同一套起服方式）
  const app = createApp();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  resetDbForTests();
  db.close();
});

async function api(
  method: string,
  p: string,
  token?: string,
  body?: unknown
): Promise<{ status: number; data: Record<string, unknown> }> {
  // exactOptionalPropertyTypes：body 用条件展开，不显式传 undefined
  const init: RequestInit = {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
  const res = await fetch(`${base}${p}`, init);
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

// ------------------------------------------------------------------
// A. 鉴权签名
// ------------------------------------------------------------------

describe('oppoAuthSign', () => {
  it('是 sha256(appKey+timestamp+masterSecret) 的十六进制小写形式', () => {
    const expected = crypto
      .createHash('sha256')
      .update('appkey-1' + '1700000000000' + 'master-2')
      .digest('hex');
    expect(oppoAuthSign('appkey-1', 1_700_000_000_000, 'master-2')).toBe(expected);
  });

  it('对输入变化敏感（改任何一位结果都变）', () => {
    const a = oppoAuthSign('k', 1_700_000_000_000, 's');
    const b = oppoAuthSign('k', 1_700_000_000_001, 's');
    expect(a).not.toBe(b);
  });
});

describe('clampChars', () => {
  it('超长截断、不超长原样', () => {
    expect(clampChars('abc', 5)).toBe('abc');
    expect(clampChars('abcdefg', 5)).toBe('abcde');
  });
});

describe('DEFAULT_PUSH_CHANNEL_ID（跨端契约）', () => {
  it('等于客户端「新消息」通道第一代 id —— 改任一侧都要同步改另一侧', () => {
    // 客户端：android/.../SocialNotifier.kt 的 CHANNEL_MESSAGES
    //（Android 9+ 的推送必须带与设备一致的通道 id，缺了/对不上会被系统静默丢弃）
    expect(DEFAULT_PUSH_CHANNEL_ID).toBe('k_messages_v2');
  });
});

// ------------------------------------------------------------------
// B. 文案组装（哪些事件该推）
// ------------------------------------------------------------------

describe('composePush', () => {
  it('新私信：标题 = 发送者昵称，正文 = 最新一条消息，深链 chat:<from>', () => {
    db.prepare('INSERT INTO messages (sender_id, receiver_id, content) VALUES (?, ?, ?)').run(
      BOB,
      ALICE,
      '晚上一起吃饭吗'
    );
    expect(composePush(ALICE, { type: 'message', from: BOB, to: ALICE })).toEqual({
      title: 'bob',
      body: '晚上一起吃饭吗',
      deepLink: `chat:${BOB}`,
    });
  });

  it('图片消息给 [图片] 占位（服务端没有文本可读）', () => {
    db.prepare('INSERT INTO messages (sender_id, receiver_id, content, image_url) VALUES (?, ?, ?, ?)').run(
      BOB,
      ALICE,
      '',
      'x.jpg'
    );
    expect(composePush(ALICE, { type: 'message', from: BOB, to: ALICE })?.body).toBe('[图片]');
  });

  it('同一个人连发多条：标题带未读计数（QQ 式「昵称(N条新消息)」，2026-10-11）', () => {
    // 此前两个用例已给 BOB → ALICE 插过 2 条未读，这里再插一条凑 3
    db.prepare('INSERT INTO messages (sender_id, receiver_id, content) VALUES (?, ?, ?)').run(
      BOB,
      ALICE,
      '第三条'
    );
    expect(composePush(ALICE, { type: 'message', from: BOB, to: ALICE })).toEqual({
      title: 'bob(3条新消息)',
      body: '第三条',
      deepLink: `chat:${BOB}`,
    });
  });

  it('发给别人的消息事件不推（发送者两端的同步事件）', () => {
    expect(composePush(BOB, { type: 'message', from: BOB, to: ALICE })).toBeNull();
  });

  it('撤回 / 清除是静默同步事件，不推', () => {
    expect(composePush(ALICE, { type: 'message', from: BOB, to: ALICE, recalled: 1 })).toBeNull();
    expect(composePush(ALICE, { type: 'message', from: BOB, to: ALICE, cleared: true })).toBeNull();
  });

  it('评论帖子 → 「评论了你的帖子：<内容>」，深链 post:<id>', () => {
    db.prepare("INSERT INTO posts (id, user_id, image_url) VALUES (900, ?, '[]')").run(ALICE);
    db.prepare('INSERT INTO comments (id, user_id, post_id, content) VALUES (901, ?, 900, ?)').run(
      BOB,
      '写得真好'
    );
    expect(composePush(ALICE, { type: 'notification', comment_id: 901, post_id: 900 })).toEqual({
      title: 'bob',
      body: '评论了你的帖子：写得真好',
      deepLink: 'post:900',
    });
  });

  it('回复评论 → 「回复了你的评论：<内容>」', () => {
    db.prepare(
      'INSERT INTO comments (id, user_id, post_id, parent_id, content) VALUES (902, ?, 900, 901, ?)'
    ).run(BOB, '同意');
    expect(composePush(ALICE, { type: 'notification', comment_id: 902, post_id: 900 })?.body).toBe(
      '回复了你的评论：同意'
    );
  });

  it('数据已不存在（如评论被删）时静默不推', () => {
    expect(composePush(ALICE, { type: 'notification', comment_id: 999_999, post_id: 900 })).toBeNull();
  });

  it('定向公告 → 「新公告」+ 公告标题；全体公告不推给个人；已删公告不推', () => {
    db.prepare(
      'INSERT INTO announcements (id, title, content, target_user_id, from_user_id) VALUES (910, ?, ?, ?, ?)'
    ).run('服务维护通知', '今晚 23:00 维护', ALICE, BOB);
    expect(composePush(ALICE, { type: 'announcement', announcement_id: 910 })).toEqual({
      title: '新公告',
      body: '服务维护通知',
      deepLink: 'announcements',
    });
    // 全体公告（target_user_id = NULL）：逐设备广播走 pushAnnouncementToAll，不由个人事件推
    db.prepare(
      'INSERT INTO announcements (id, title, content, target_user_id, from_user_id) VALUES (911, ?, ?, NULL, ?)'
    ).run('全站公告', 'x', BOB);
    expect(composePush(ALICE, { type: 'announcement', announcement_id: 911 })).toBeNull();
    // 删除事件复用同一类型：行没了 → 不推
    expect(composePush(ALICE, { type: 'announcement', announcement_id: 999_999 })).toBeNull();
  });
});

// ------------------------------------------------------------------
// C. 设备仓库（绑定 / 换绑 / 解绑语义）
// ------------------------------------------------------------------

describe('push.repo', () => {
  it('同一 token 换账号登录会改写绑定（旧账号不再收到推送）', () => {
    pushRepo.upsertDevice({ userId: ALICE, provider: 'oppo', token: 'tok-a', packageName: 'top.k' });
    expect(pushRepo.listTokensByUser(ALICE)).toEqual(['tok-a']);

    pushRepo.upsertDevice({ userId: BOB, provider: 'oppo', token: 'tok-a', packageName: 'top.k' });
    expect(pushRepo.listTokensByUser(ALICE)).toEqual([]);
    expect(pushRepo.listTokensByUser(BOB)).toEqual(['tok-a']);
  });

  it('解绑只能删自己名下的 token', () => {
    pushRepo.upsertDevice({ userId: ALICE, provider: 'oppo', token: 'tok-x' });
    expect(pushRepo.deleteTokensForUser(BOB, ['tok-x'])).toBe(0);
    expect(pushRepo.listTokensByUser(ALICE)).toEqual(['tok-x']);
    expect(pushRepo.deleteTokensForUser(ALICE, ['tok-x'])).toBe(1);
    expect(pushRepo.listTokensByUser(ALICE)).toEqual([]);
  });

  it('失效回执清理按 token 删（不校验归属）且不误删别的 token', () => {
    pushRepo.upsertDevice({ userId: ALICE, provider: 'oppo', token: 'dead-1' });
    pushRepo.upsertDevice({ userId: ALICE, provider: 'oppo', token: 'alive-1' });
    expect(pushRepo.deleteTokens(['dead-1'])).toBe(1);
    expect(pushRepo.listTokensByUser(ALICE)).toEqual(['alive-1']);
    pushRepo.deleteTokens(['alive-1']);
  });

  it('通道 id 会随设备入库；旧客户端（不带 channelId）重注册不会抹掉已存值（COALESCE）', () => {
    pushRepo.upsertDevice({
      userId: ALICE,
      provider: 'oppo',
      token: 'tok-chan',
      channelId: 'k_messages_v2_g2',
    });
    expect(pushRepo.listDevicesByUser(ALICE).find((d) => d.token === 'tok-chan')?.channelId).toBe(
      'k_messages_v2_g2'
    );

    // 模拟旧版客户端（0.1.15）重新注册：不带 channelId —— 已存值必须保留
    pushRepo.upsertDevice({ userId: ALICE, provider: 'oppo', token: 'tok-chan', packageName: 'top.k' });
    expect(pushRepo.listDevicesByUser(ALICE).find((d) => d.token === 'tok-chan')?.channelId).toBe(
      'k_messages_v2_g2'
    );

    pushRepo.deleteTokens(['tok-chan']);
  });
});

// ------------------------------------------------------------------
// D. HTTP 路由
// ------------------------------------------------------------------

describe('POST/DELETE /api/push/devices', () => {
  it('未登录 401', async () => {
    const res = await api('POST', '/api/push/devices', undefined, { token: 'abcdefgh' });
    expect(res.status).toBe(401);
  });

  it('参数校验：token 过短 400', async () => {
    const res = await api('POST', '/api/push/devices', aliceToken, { token: 'short' });
    expect(res.status).toBe(400);
  });

  it('注册成功并入库（含通道 id）；重复注册幂等', async () => {
    const res = await api('POST', '/api/push/devices', aliceToken, {
      token: 'reg-token-123456',
      package_name: 'top.kuangdada.k.nativeapp',
      channel_id: 'k_messages_v2_g2',
    });
    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(true);
    expect(pushRepo.listTokensByUser(ALICE)).toContain('reg-token-123456');
    expect(pushRepo.listDevicesByUser(ALICE).find((d) => d.token === 'reg-token-123456')?.channelId).toBe(
      'k_messages_v2_g2'
    );

    // 旧客户端（不带 channel_id）重复注册：token 仍幂等，且已存通道被保留
    await api('POST', '/api/push/devices', aliceToken, { token: 'reg-token-123456' });
    expect(pushRepo.listTokensByUser(ALICE).filter((t) => t === 'reg-token-123456')).toHaveLength(1);
    expect(pushRepo.listDevicesByUser(ALICE).find((d) => d.token === 'reg-token-123456')?.channelId).toBe(
      'k_messages_v2_g2'
    );
  });

  it('解绑成功（幂等：删不到也返回 ok）', async () => {
    const res = await api('DELETE', '/api/push/devices', aliceToken, { token: 'reg-token-123456' });
    expect(res.status).toBe(200);
    expect(pushRepo.listTokensByUser(ALICE)).not.toContain('reg-token-123456');

    const again = await api('DELETE', '/api/push/devices', aliceToken, { token: 'reg-token-123456' });
    expect(again.status).toBe(200);
  });

  it('解绑不能删别人名下的 token（换绑后原账号删不掉）', async () => {
    await api('POST', '/api/push/devices', bobToken, { token: 'bind-by-bob-1' });
    // alice 试图删 bob 的 token：请求成功但一行都删不掉
    const res = await api('DELETE', '/api/push/devices', aliceToken, { token: 'bind-by-bob-1' });
    expect(res.status).toBe(200);
    expect(pushRepo.listTokensByUser(BOB)).toContain('bind-by-bob-1');
    pushRepo.deleteTokens(['bind-by-bob-1']);
  });
});
