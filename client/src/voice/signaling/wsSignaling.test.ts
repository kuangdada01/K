/**
 * ============================================================
 * 信令 WS 传输单测（voice/signaling/wsSignaling.test）
 * ============================================================
 * fake WebSocket 验证：连接生命周期、JSON 坏包丢弃、终止类关闭码
 * （4001/4002/4003）不再重连、网络抖动按固定间隔自动重连、主动关闭
 * 后的所有抑制、wsUrl 的令牌转义与平台分支（mock Capacitor/config）。
 * ============================================================
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Capacitor } from '@capacitor/core';
import { getServerUrl } from '../../config';
import { WsSignaling, type WsSignalingOptions } from './wsSignaling';

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: vi.fn(() => false) },
}));

vi.mock('../../config', () => ({
  getServerUrl: vi.fn(() => ''),
}));

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readyState = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000): void {
    this._close(code);
  }

  // ---- 测试驱动 ----
  _open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  _message(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  _close(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

describe('WsSignaling', () => {
  let events: string[];
  let opts: WsSignalingOptions;
  let s: WsSignaling;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    events = [];
    opts = {
      onOpen: () => events.push('open'),
      onMessage: (msg) => events.push(`msg:${JSON.stringify(msg)}`),
      onTerminalClose: (code) => events.push(`terminal:${code}`),
      onNetworkClose: () => events.push('network'),
    };
    s = new WsSignaling(opts);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('open：建立连接（URL 为内部 wsUrl 构造：同源 + token 查询参数）并在 onopen 后回调 onOpen', () => {
    s.open();
    const ws = FakeWebSocket.instances[0]!;
    expect(ws).toBeDefined();
    // 未设 token → 空 token；jsdom location 为 http://localhost:3000
    expect(ws.url).toBe('ws://localhost:3000/api/voice/ws?token=');
    ws._open();
    expect(events).toEqual(['open']);
  });

  it('send：仅连接就绪时发送 JSON；未连接返回 false', () => {
    s.open();
    const ws = FakeWebSocket.instances[0]!;
    expect(s.send({ type: 'join', roomId: 1 })).toBe(false); // CONNECTING
    ws._open();
    expect(s.isOpen()).toBe(true);
    expect(s.send({ type: 'join', roomId: 1 })).toBe(true);
    expect(ws.sent).toEqual(['{"type":"join","roomId":1}']);
  });

  it('onmessage：合法 JSON 交给 onMessage；坏包静默丢弃', () => {
    s.open();
    const ws = FakeWebSocket.instances[0]!;
    ws._message({ type: 'joined', participants: [] });
    expect(events).toEqual(['msg:{"type":"joined","participants":[]}']);
    ws.onmessage?.({ data: '{broken' });
    expect(events).toHaveLength(1);
  });

  it.each([4001, 4002, 4003])('终止类关闭码 %i：回调后不再重连', (code) => {
    s.open();
    FakeWebSocket.instances[0]!._open();
    FakeWebSocket.instances[0]!._close(code);
    expect(events).toEqual(['open', `terminal:${code}`]);
    expect(FakeWebSocket.instances).toHaveLength(1); // 无重连
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('网络抖动断线：onNetworkClose 后按固定间隔自动重连', () => {
    s.open();
    const ws = FakeWebSocket.instances[0]!;
    ws._open();
    ws._close(1006); // 网络不可达等非终止关闭码
    expect(events).toEqual(['open', 'network']);
    expect(FakeWebSocket.instances).toHaveLength(1); // 尚未重连
    vi.advanceTimersByTime(2999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2); // 3000ms 后重连
    FakeWebSocket.instances[1]!._open();
    expect(events).toEqual(['open', 'network', 'open']);
  });

  it('连续断线：每次网络关闭都重新进入重连周期', () => {
    s.open();
    FakeWebSocket.instances[0]!._open();
    FakeWebSocket.instances[0]!._close(1006);
    vi.advanceTimersByTime(3000);
    FakeWebSocket.instances[1]!._open();
    FakeWebSocket.instances[1]!._close(1006);
    vi.advanceTimersByTime(3000);
    expect(FakeWebSocket.instances).toHaveLength(3);
    expect(events.filter((e) => e === 'network')).toHaveLength(2);
  });

  it('close：主动关闭后断线不再重连，当前连接 onclose 被抑制', () => {
    s.open();
    FakeWebSocket.instances[0]!._open();
    s.close();
    FakeWebSocket.instances[0]!._close(1006);
    expect(events).toEqual(['open']);
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('close：重连等待期间取消定时器', () => {
    s.open();
    FakeWebSocket.instances[0]!._open();
    FakeWebSocket.instances[0]!._close(1006);
    s.close();
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('open：终止后再次调用被抑制（会话已结束）', () => {
    s.open();
    FakeWebSocket.instances[0]!._close(4003);
    s.open();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('url：网页端走同源 host（token 转义）；原生端直连配置的服务器（http→ws / https→wss）', () => {
    localStorage.setItem('k_token', 'a b&c');
    vi.mocked(getServerUrl).mockReturnValue('');

    // 网页端（location 由 jsdom 提供，http://localhost:3000）
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    s.open();
    expect(FakeWebSocket.instances[0]!.url).toBe('ws://localhost:3000/api/voice/ws?token=a%20b%26c');

    // 原生端：http 服务器 → ws://
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(getServerUrl).mockReturnValue('http://192.168.1.5:3000');
    const s2 = new WsSignaling(opts);
    s2.open();
    expect(FakeWebSocket.instances[1]!.url).toBe('ws://192.168.1.5:3000/api/voice/ws?token=a%20b%26c');

    // 原生端：https 服务器 → wss://
    vi.mocked(getServerUrl).mockReturnValue('https://voice.example.com');
    const s3 = new WsSignaling(opts);
    s3.open();
    expect(FakeWebSocket.instances[2]!.url).toBe('wss://voice.example.com/api/voice/ws?token=a%20b%26c');
  });
});
