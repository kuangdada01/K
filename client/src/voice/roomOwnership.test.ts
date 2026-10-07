/**
 * ============================================================
 * 访客房间所有权令牌存储测试（voice/roomOwnership —— P2-25）
 * ============================================================
 * 服务端把访客房间的所有权从「来源 IP」换成「房间级令牌」，代价是客户端必须
 * **可靠地保存并在删除/清聊天时带上**它 —— 丢了就等于自己的房间谁都删不掉。
 *
 * 覆盖:
 * - 保存/读取/忘记
 * - 持久化在 localStorage（刷新后仍能管理自己的房间）
 * - 按房间列表裁剪（房间没了就清掉令牌，避免无限堆积）
 * - 脏数据（非对象/数组/非字符串值）不让后续逻辑炸掉
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  saveRoomOwnerToken,
  getRoomOwnerToken,
  forgetRoomOwnerToken,
  isOwnedGuestRoom,
  pruneRoomOwnerTokens,
  clearRoomOwnerTokensForTests,
} from './roomOwnership';

const KEY = 'voice:roomOwnerTokens';

beforeEach(() => {
  clearRoomOwnerTokensForTests();
  localStorage.clear();
});

describe('令牌保存与读取', () => {
  it('保存后可读到，且写进 localStorage（刷新不丢）', () => {
    saveRoomOwnerToken(7, 'tk-7');
    expect(getRoomOwnerToken(7)).toBe('tk-7');
    expect(isOwnedGuestRoom(7)).toBe(true);
    expect(localStorage.getItem(KEY)).toContain('tk-7');
  });

  it('未保存过的房间：读不到、也不是自己的', () => {
    expect(getRoomOwnerToken(99)).toBeUndefined();
    expect(isOwnedGuestRoom(99)).toBe(false);
  });

  it('空令牌不写入（避免存下无意义的空串）', () => {
    saveRoomOwnerToken(7, undefined);
    saveRoomOwnerToken(7, null);
    saveRoomOwnerToken(7, '');
    expect(isOwnedGuestRoom(7)).toBe(false);
  });

  it('忘记后不再是自己拥有', () => {
    saveRoomOwnerToken(7, 'tk-7');
    forgetRoomOwnerToken(7);
    expect(isOwnedGuestRoom(7)).toBe(false);
  });

  it('多个房间互不干扰', () => {
    saveRoomOwnerToken(1, 'a');
    saveRoomOwnerToken(2, 'b');
    expect(getRoomOwnerToken(1)).toBe('a');
    expect(getRoomOwnerToken(2)).toBe('b');
    forgetRoomOwnerToken(1);
    expect(isOwnedGuestRoom(1)).toBe(false);
    expect(getRoomOwnerToken(2)).toBe('b');
  });
});

describe('按房间列表裁剪', () => {
  it('★ 房间消失后令牌被清掉（本地不会无限堆积）', () => {
    saveRoomOwnerToken(1, 'a');
    saveRoomOwnerToken(2, 'b');
    saveRoomOwnerToken(3, 'c');

    pruneRoomOwnerTokens([2, 3]);
    expect(isOwnedGuestRoom(1)).toBe(false);
    expect(getRoomOwnerToken(2)).toBe('b');
    expect(getRoomOwnerToken(3)).toBe('c');
  });

  it('列表为空时清空全部', () => {
    saveRoomOwnerToken(1, 'a');
    pruneRoomOwnerTokens([]);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('没有可裁剪项时不改内容', () => {
    saveRoomOwnerToken(1, 'a');
    const before = localStorage.getItem(KEY);
    pruneRoomOwnerTokens([1, 2]);
    expect(localStorage.getItem(KEY)).toBe(before);
  });
});

describe('脏数据容错', () => {
  it('存量不是 JSON → 视为空表，不抛错', () => {
    localStorage.setItem(KEY, '{not json');
    expect(getRoomOwnerToken(1)).toBeUndefined();
    saveRoomOwnerToken(1, 'a');
    expect(getRoomOwnerToken(1)).toBe('a');
  });

  it('存量是数组/字符串 → 视为空表', () => {
    localStorage.setItem(KEY, '[1,2,3]');
    expect(getRoomOwnerToken(1)).toBeUndefined();
    localStorage.setItem(KEY, '"str"');
    expect(getRoomOwnerToken(1)).toBeUndefined();
  });

  it('值不是字符串的条目被忽略（不会把对象当令牌用）', () => {
    localStorage.setItem(KEY, JSON.stringify({ '1': 'ok', '2': 42, '3': null, '4': { a: 1 } }));
    expect(getRoomOwnerToken(1)).toBe('ok');
    expect(getRoomOwnerToken(2)).toBeUndefined();
    expect(getRoomOwnerToken(3)).toBeUndefined();
    expect(getRoomOwnerToken(4)).toBeUndefined();
  });
});
