/**
 * ============================================================
 * 语音房间 API 的所有权令牌附加测试（api/voice —— P2-25）
 * ============================================================
 * 客户端保存的令牌必须真的**挂到删除/清聊天的请求上**，否则服务端会 403
 * （而 UI 上按钮是可见的，用户只会看到「删除失败」）。用自定义 adapter 直接
 * 观察请求头，锁住这条契约。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import api from './http';
import { deleteVoiceRoom, clearVoiceRoomMessages, createVoiceRoom } from './voice';
import { saveRoomOwnerToken, clearRoomOwnerTokensForTests } from '../voice/roomOwnership';

/** 记录最近一次请求的 config，并按需返回响应体 */
let lastConfig: AxiosRequestConfig | null = null;
let responseBody: unknown = { success: true };

function stubAdapter(status = 200) {
  api.defaults.adapter = async (config: AxiosRequestConfig) => {
    lastConfig = config;
    return {
      data: responseBody,
      status,
      statusText: 'OK',
      headers: {},
      config: config as never,
    } as AxiosResponse;
  };
}

let originalAdapter: typeof api.defaults.adapter;

beforeEach(() => {
  originalAdapter = api.defaults.adapter;
  lastConfig = null;
  responseBody = { success: true };
  clearRoomOwnerTokensForTests();
  localStorage.clear();
  stubAdapter();
});

afterEach(() => {
  (api.defaults as { adapter?: unknown }).adapter = originalAdapter;
  vi.restoreAllMocks();
});

/** axios 会把请求头规整到一个对象里；取出我们关心的那个 */
function headerOf(name: string): unknown {
  const headers = (lastConfig?.headers ?? {}) as Record<string, unknown>;
  return headers[name];
}

describe('deleteVoiceRoom', () => {
  it('★ 本地有令牌时带上 X-Voice-Owner-Token', async () => {
    saveRoomOwnerToken(42, 'tk-42');
    await deleteVoiceRoom(42);
    expect(String(lastConfig?.url)).toContain('/voice/rooms/42');
    expect(headerOf('X-Voice-Owner-Token')).toBe('tk-42');
  });

  it('本地无令牌时（登录用户/管理员）不带该头', async () => {
    await deleteVoiceRoom(42);
    expect(headerOf('X-Voice-Owner-Token')).toBeUndefined();
  });

  it('令牌放请求头而不是查询串（URL 会进访问日志）', async () => {
    saveRoomOwnerToken(42, 'tk-42');
    await deleteVoiceRoom(42);
    expect(String(lastConfig?.url)).not.toContain('tk-42');
  });
});

describe('clearVoiceRoomMessages', () => {
  it('★ 同样带上令牌', async () => {
    saveRoomOwnerToken(7, 'tk-7');
    await clearVoiceRoomMessages(7);
    expect(String(lastConfig?.url)).toContain('/voice/rooms/7/messages');
    expect(headerOf('X-Voice-Owner-Token')).toBe('tk-7');
  });

  it('无令牌时不带该头', async () => {
    await clearVoiceRoomMessages(7);
    expect(headerOf('X-Voice-Owner-Token')).toBeUndefined();
  });
});

describe('createVoiceRoom', () => {
  it('把 ownerToken 原样透传给调用方（由调用方负责保存）', async () => {
    responseBody = { room: { id: 9, name: '房' }, ownerToken: 'tk-9' };
    const res = await createVoiceRoom('房');
    expect(res.ownerToken).toBe('tk-9');
    expect(res.room.id).toBe(9);
  });

  it('登录用户建房时没有 ownerToken 字段', async () => {
    responseBody = { room: { id: 9, name: '房' } };
    const res = await createVoiceRoom('房');
    expect(res.ownerToken).toBeUndefined();
  });
});
