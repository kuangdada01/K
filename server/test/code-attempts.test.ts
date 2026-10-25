/**
 * ============================================================
 * 验证码撞码防护测试（HTTP 层）
 * ============================================================
 * findValidCode 此前不计失败次数：6 位码在攻击者轮换 IP 时可绕过
 * 「按 IP 的登录限流」（10 次/15 分钟/IP）逐次试错，10 分钟有效期内
 * 理论碰撞空间不可忽略。现在每次校验失败 +1（registerCodeFailure），
 * 累计 MAX_CODE_FAILED_ATTEMPTS 即作废该邮箱全部未过期验证码。
 *
 * 覆盖：
 * A. 注册路径：错 4 次后正确码仍可用（正常容错不被误伤）
 * B. 注册路径：第 5 次错误后正确码也 400（作废，库里无残留）
 * C. 重置密码路径同样计数（两处调用点都要接线，漏一处就是半个洞）
 *
 * 注意：register 挂了 authLimiter（10 次/15 分钟/IP），测试服务器跑在
 * 127.0.0.1（trust proxy='loopback' 会采纳 X-Forwarded-For），
 * 每个用例用独立伪 IP 隔离限流窗口。
 * ============================================================
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import Database from 'better-sqlite3';
import { createMemoryDb } from './helpers/memdb';
import { setDbForTests, resetDbForTests } from '../src/db/connection';
import { createApp } from '../src/app';
import * as authRepo from '../src/repositories/auth.repo';

let db: InstanceType<typeof Database>;
let server: http.Server;
let base = '';

/** 发一次注册请求；ip 用于错开 authLimiter 的限流窗口 */
async function tryRegister(body: object, ip: string): Promise<number> {
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify(body),
  });
  return res.status;
}

async function tryReset(body: object, ip: string): Promise<number> {
  const res = await fetch(`${base}/api/auth/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify(body),
  });
  return res.status;
}

/** 直接落一条 10 分钟后过期的验证码（绕过发信环节） */
function seedCode(email: string, code: string): void {
  authRepo.saveVerificationCode(email, code, new Date(Date.now() + 10 * 60 * 1000).toISOString());
}

beforeAll(async () => {
  db = createMemoryDb();
  setDbForTests(db);
  server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  resetDbForTests();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

describe('验证码错误次数上限', () => {
  it('A. 错 4 次后正确码仍可用（容错不误伤）', async () => {
    const email = 'attempts-a@test.local';
    seedCode(email, '111222');
    const good = { username: 'att_user_a', email, password: 'good-password-1', code: '111222' };

    for (let i = 0; i < 4; i++) {
      const status = await tryRegister({ ...good, code: '000000' }, '10.9.0.1');
      expect(status).toBe(400);
    }
    // 正确码在 4 次失败后仍有效：注册成功（成功路径顺带删除验证码）
    expect(await tryRegister(good, '10.9.0.1')).toBe(201);
    expect(authRepo.findValidCode(email, '111222')).toBeUndefined();
  });

  it('B. 第 5 次错误后作废：正确码也 400，库里无残留', async () => {
    const email = 'attempts-b@test.local';
    seedCode(email, '333444');
    const good = { username: 'att_user_b', email, password: 'good-password-1', code: '333444' };

    for (let i = 0; i < 5; i++) {
      expect(await tryRegister({ ...good, code: '999999' }, '10.9.0.2')).toBe(400);
    }
    // 达到上限：码已作废，连正确码也拒绝
    expect(await tryRegister(good, '10.9.0.2')).toBe(400);
    expect(authRepo.findValidCode(email, '333444')).toBeUndefined();
  });

  it('C. 重置密码路径同样计数', async () => {
    const email = 'attempts-c@test.local';
    // 先造一个真实用户（重置要求邮箱已注册）
    seedCode(email, '555666');
    expect(
      await tryRegister(
        { username: 'att_user_c', email, password: 'old-password-123', code: '555666' },
        '10.9.0.3'
      )
    ).toBe(201);

    seedCode(email, '777888');
    const good = { email, password: 'new-password-456', code: '777888' };
    for (let i = 0; i < 5; i++) {
      expect(await tryReset({ ...good, code: '000001' }, '10.9.0.4')).toBe(400);
    }
    // 重置同样撞上限：正确码也拒绝，密码未变
    expect(await tryReset(good, '10.9.0.4')).toBe(400);
    expect(authRepo.findValidCode(email, '777888')).toBeUndefined();
  });
});
