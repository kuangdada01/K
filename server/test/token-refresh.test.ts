/**
 * ============================================================
 * 滑动续期测试（token 有效期 7 天 + 活跃会话自动续期）
 * ============================================================
 * 背景：token 是 7 天有效期且**没有任何续期机制**，于是「用满 7 天必然掉线」。
 * 2026-09 线上事故里，掉线的瞬间客户端静默降级成访客，再叠加同 IP 访客共号，
 * 演变成「有人一直被踢出语音」。互踢与静默降级已分别修掉，这里解决留下的源头：
 * 让**活跃用户不会因为到点被登出**，而彻底沉默的会话仍按 7 天失效。
 *
 * 覆盖:
 * - 判定函数 shouldRefreshToken 的边界（缺失 iat / 未到阈值 / 恰好到阈值）
 * - 已认证请求在 token 较旧时带回 X-Refreshed-Token，且新 token 可用
 * - 刚签发的 token 不续期（避免每个请求都换发）
 * - 续期后的新 token 仍受 token_version 约束（改密即失效）
 * - 未认证请求不带该响应头
 * - CORS 暴露该响应头（跨源端安卓 WebView 否则读不到）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import { createMemoryDb } from './helpers/memdb';
import { setDbForTests, resetDbForTests } from '../src/db/connection';
import { createApp } from '../src/app';
import {
  generateToken,
  shouldRefreshToken,
  verifyLiveToken,
  JWT_SECRET,
  TOKEN_REFRESH_AFTER_MS,
  REFRESHED_TOKEN_HEADER,
} from '../src/lib/jwt';

let db: InstanceType<typeof Database>;
let server: http.Server;
let base = '';
let userId = 0;
let tokenVersion = 0;

/** 造一张「签发于 N 秒前」的合法 token（same secret / same tv），用于模拟旧 token */
function tokenIssuedSecondsAgo(seconds: number): string {
  const iat = Math.floor(Date.now() / 1000) - seconds;
  // 注意不要用 noTimestamp：它会把 payload.iat **删掉**（实测），
  // 于是 token 看起来像「没有签发时间」，续期判定会保守跳过。
  // 直接给显式 iat 即可：jsonwebtoken 以 payload.iat 为基准计算 exp，并原样保留它。
  return jwt.sign({ id: userId, username: 'alice', tv: tokenVersion, iat }, JWT_SECRET, {
    expiresIn: '7d',
    algorithm: 'HS256',
  });
}

async function getMe(token?: string) {
  const res = await fetch(`${base}/api/auth/me`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return res;
}

beforeAll(async () => {
  db = createMemoryDb();
  setDbForTests(db);

  const info = db
    .prepare("INSERT INTO users (username, email, password_hash) VALUES ('alice', 'alice@test.com', 'x')")
    .run();
  userId = Number(info.lastInsertRowid);
  tokenVersion = (
    db.prepare('SELECT token_version FROM users WHERE id = ?').get(userId) as { token_version: number }
  ).token_version;

  const app = createApp();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  resetDbForTests();
  db?.close();
});

describe('shouldRefreshToken 判定', () => {
  const now = 1_800_000_000_000; // 固定「现在」，避免依赖真实时间

  it('iat 缺失（0）时不续期：缺信息宁可不折腾', () => {
    expect(shouldRefreshToken(0, now)).toBe(false);
  });

  it('刚签发（未到阈值）不续期', () => {
    expect(shouldRefreshToken(now / 1000, now)).toBe(false);
    expect(shouldRefreshToken(now / 1000 - 60, now)).toBe(false);
  });

  it('恰好到阈值即续期（边界为闭区间）', () => {
    const atThreshold = now / 1000 - TOKEN_REFRESH_AFTER_MS / 1000;
    expect(shouldRefreshToken(atThreshold, now)).toBe(true);
    expect(shouldRefreshToken(atThreshold + 1, now)).toBe(false);
  });

  it('超过阈值续期（越旧越该续）', () => {
    expect(shouldRefreshToken(now / 1000 - 3 * 24 * 3600, now)).toBe(true);
  });
});

describe('已认证请求的滑动续期', () => {
  it('token 较旧时带回 X-Refreshed-Token，且新 token 立即可用', async () => {
    const old = tokenIssuedSecondsAgo(2 * 24 * 3600); // 2 天前签发（> 1 天阈值）
    const res = await getMe(old);
    expect(res.status).toBe(200);

    const refreshed = res.headers.get(REFRESHED_TOKEN_HEADER);
    expect(refreshed, '应下发续期 token').toBeTruthy();

    // 新 token 必须真的可用，且身份一致
    const live = verifyLiveToken(refreshed!);
    expect(live?.id).toBe(userId);
    expect(live?.username).toBe('alice');

    // 用新 token 再请求：刚签发 → 不再续期（避免每个请求都换发）
    const again = await getMe(refreshed!);
    expect(again.status).toBe(200);
    expect(again.headers.get(REFRESHED_TOKEN_HEADER)).toBeNull();
  });

  it('刚签发的 token 不续期', async () => {
    const fresh = generateToken({ id: userId, username: 'alice', tv: tokenVersion });
    const res = await getMe(fresh);
    expect(res.status).toBe(200);
    expect(res.headers.get(REFRESHED_TOKEN_HEADER)).toBeNull();
  });

  it('旧 token 在有效期内仍可用（续期不是强制换发）', async () => {
    const old = tokenIssuedSecondsAgo(6 * 24 * 3600);
    const res = await getMe(old);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { username: string }).username).toBe('alice');
  });

  it('★ 续期不能绕过吊销：改密（token_version+1）后旧 token 与续期 token 都失效', async () => {
    const old = tokenIssuedSecondsAgo(2 * 24 * 3600);
    const refreshed = (await getMe(old)).headers.get(REFRESHED_TOKEN_HEADER)!;
    expect(verifyLiveToken(refreshed)).toBeDefined();

    // 模拟改密：递增 token_version（auth.repo/admin.repo 的实际做法）
    db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(userId);

    // 旧 token 失效，续期下发的 token 也一并失效（因为它带的是旧 tv）
    expect(verifyLiveToken(old)).toBeUndefined();
    expect(verifyLiveToken(refreshed)).toBeUndefined();
    expect((await getMe(refreshed)).status).toBe(401);

    // 恢复版本，避免影响后续用例
    db.prepare('UPDATE users SET token_version = token_version - 1 WHERE id = ?').run(userId);
  });

  it('未认证请求不下发续期头', async () => {
    const res = await getMe();
    expect(res.status).toBe(401);
    expect(res.headers.get(REFRESHED_TOKEN_HEADER)).toBeNull();
  });

  it('过期的 token 不会拿到续期（401，不续期）', async () => {
    const expired = jwt.sign({ id: userId, username: 'alice', tv: tokenVersion }, JWT_SECRET, {
      expiresIn: -10,
      algorithm: 'HS256',
    });
    const res = await getMe(expired);
    expect(res.status).toBe(401);
    expect(res.headers.get(REFRESHED_TOKEN_HEADER)).toBeNull();
  });

  it('CORS 暴露续期响应头（跨源端否则读不到）', async () => {
    const res = await fetch(`${base}/api/auth/me`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost', 'Access-Control-Request-Method': 'GET' },
    });
    expect(res.headers.get('access-control-expose-headers')).toBe(REFRESHED_TOKEN_HEADER);
  });
});
