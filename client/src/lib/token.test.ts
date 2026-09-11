/**
 * ============================================================
 * 客户端 token 工具测试（lib/token —— 滑动续期落盘）
 * ============================================================
 * 覆盖:
 * - parseTokenIssuedAt：正常 / 缺 iat / 非 JWT / 坏 base64 / 空值
 * - ★ 含中文 username 的 payload 仍能正确解析（base64 → UTF-8 解码，
 *   直接用 atob 结果 JSON.parse 会得到乱码）
 * - storeRefreshedToken：更新则落盘、更旧则忽略、空值忽略、本地无 token 时落盘
 * - 续期不能把本地 token 覆盖成更旧的（并发请求乱序到达时的关键性质）
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { parseTokenIssuedAt, storeRefreshedToken } from './token';

/** 造一张形如真实 JWT 的 token（签名段无意义，客户端只解析 payload） */
function makeToken(payload: Record<string, unknown>): string {
  const enc = (obj: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(payload)}.fakesignature`;
}

beforeEach(() => {
  localStorage.clear();
});

describe('parseTokenIssuedAt', () => {
  it('读取 payload 的 iat', () => {
    expect(parseTokenIssuedAt(makeToken({ id: 1, iat: 1788883037 }))).toBe(1788883037);
  });

  it('★ 中文 username 的 payload 也能正确解析（UTF-8 解码）', () => {
    const token = makeToken({ id: 1, username: '张三丰·测试', iat: 1788883037 });
    expect(parseTokenIssuedAt(token)).toBe(1788883037);
  });

  it('缺 iat / 非数字 iat → 0', () => {
    expect(parseTokenIssuedAt(makeToken({ id: 1 }))).toBe(0);
    expect(parseTokenIssuedAt(makeToken({ id: 1, iat: '1788883037' }))).toBe(0);
  });

  it('空值 / 非 JWT / 坏 base64 → 0（不抛错）', () => {
    expect(parseTokenIssuedAt(null)).toBe(0);
    expect(parseTokenIssuedAt(undefined)).toBe(0);
    expect(parseTokenIssuedAt('')).toBe(0);
    expect(parseTokenIssuedAt('not-a-jwt')).toBe(0);
    expect(parseTokenIssuedAt('a.!!!not-base64!!!.c')).toBe(0);
  });
});

describe('storeRefreshedToken', () => {
  it('本地无 token 时直接落盘', () => {
    const fresh = makeToken({ iat: 1788883037 });
    expect(storeRefreshedToken(fresh)).toBe(true);
    expect(localStorage.getItem('k_token')).toBe(fresh);
  });

  it('新 token 更旧时忽略（并发乱序不得把本地覆盖成更旧的）', () => {
    const newer = makeToken({ iat: 1788889000 });
    const older = makeToken({ iat: 1788883037 });
    localStorage.setItem('k_token', newer);

    expect(storeRefreshedToken(older)).toBe(false);
    expect(localStorage.getItem('k_token')).toBe(newer);
  });

  it('新 token 更新时落盘', () => {
    const older = makeToken({ iat: 1788883037 });
    const newer = makeToken({ iat: 1788889000 });
    localStorage.setItem('k_token', older);

    expect(storeRefreshedToken(newer)).toBe(true);
    expect(localStorage.getItem('k_token')).toBe(newer);
  });

  it('空值 / 解析不出 iat 的 token 都不落盘', () => {
    localStorage.setItem('k_token', makeToken({ iat: 1788883037 }));
    expect(storeRefreshedToken(null)).toBe(false);
    expect(storeRefreshedToken(undefined)).toBe(false);
    expect(storeRefreshedToken('')).toBe(false);
    // 无 iat 的 token 不写入：宁可退化成不续期，也不要把不可判定的凭证存进去
    expect(storeRefreshedToken(makeToken({ id: 1 }))).toBe(false);
    expect(localStorage.getItem('k_token')).toBe(makeToken({ iat: 1788883037 }));
  });

  it('本地 token 无法解析时以新 token 为准（本地已损坏不该挡住续期）', () => {
    localStorage.setItem('k_token', 'garbage');
    const fresh = makeToken({ iat: 1788889000 });
    expect(storeRefreshedToken(fresh)).toBe(true);
    expect(localStorage.getItem('k_token')).toBe(fresh);
  });
});
