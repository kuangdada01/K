/**
 * ============================================================
 * 信令 WS 传输单测（voice/signaling/wsSignaling.test）
 * ============================================================
 * fake WebSocket 验证：连接生命周期、JSON 坏包丢弃、终止类关闭码
 * （4001/4002/4003）不再重连、网络抖动按固定间隔自动重连、主动关闭
 * 后的所有抑制、凭证构造与平台分支（mock Capacitor/config/api）。
 *
 * 凭证（v0.2.38 起）：登录用户先换**一次性票据**再建连（`?ticket=`），
 * JWT 不再进 URL；票据换不到时回退 `?token=`；访客不带任何凭证。
 * open() 因此变成异步（要先 await 票据），测试统一用 settle() 推进微任务。
 * ============================================================
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Capacitor } from '@capacitor/core';
import { getServerUrl } from '../../config';
import { fetchVoiceTicket } from '../../api/voice';
import { WsSignaling, type WsSignalingOptions } from './wsSignaling';

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: vi.fn(() => false) },
}));

vi.mock('../../config', () => ({
  getServerUrl: vi.fn(() => ''),
}));

vi.mock('../../api/voice', () => ({
  fetchVoiceTicket: vi.fn(),
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

  /** open() 要先 await 取票据：推进微任务直到建连完成（不受 fake timers 影响） */
  const settle = async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };

  /** 建连（含票据往返） */
  const openSettled = async (sig: WsSignaling = s) => {
    sig.open();
    await settle();
  };

  /** 推进定时器并让随之而来的重连完成 */
  const advance = async (ms: number) => {
    vi.advanceTimersByTime(ms);
    await settle();
  };

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
    vi.mocked(fetchVoiceTicket).mockResolvedValue({ ticket: 'tk-default' });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('open：建立连接（同源）并在 onopen 后回调 onOpen', async () => {
    await openSettled();
    const ws = FakeWebSocket.instances[0]!;
    expect(ws).toBeDefined();
    // 未设 token → 访客连接，不带任何凭证参数（jsdom location 为 http://localhost:3000）
    expect(ws.url).toBe('ws://localhost:3000/api/voice/ws');
    ws._open();
    expect(events).toEqual(['open']);
  });

  it('send：仅连接就绪时发送 JSON；未连接返回 false', async () => {
    await openSettled();
    const ws = FakeWebSocket.instances[0]!;
    expect(s.send({ type: 'join', roomId: 1 })).toBe(false); // CONNECTING
    ws._open();
    expect(s.isOpen()).toBe(true);
    expect(s.send({ type: 'join', roomId: 1 })).toBe(true);
    expect(ws.sent).toEqual(['{"type":"join","roomId":1}']);
  });

  it('onmessage：合法 JSON 交给 onMessage；坏包静默丢弃', async () => {
    await openSettled();
    const ws = FakeWebSocket.instances[0]!;
    ws._message({ type: 'joined', participants: [] });
    expect(events).toEqual(['msg:{"type":"joined","participants":[]}']);
    ws.onmessage?.({ data: '{broken' });
    expect(events).toHaveLength(1);
  });

  it.each([4001, 4002, 4003, 4004])('终止类关闭码 %i：回调后不再重连', async (code) => {
    await openSettled();
    FakeWebSocket.instances[0]!._open();
    FakeWebSocket.instances[0]!._close(code);
    expect(events).toEqual(['open', `terminal:${code}`]);
    expect(FakeWebSocket.instances).toHaveLength(1); // 无重连
    await advance(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('★ 4004（同 IP 连接过多）必须终止：否则会 3s 一次重连必然被拒的服务端', async () => {
    await openSettled();
    FakeWebSocket.instances[0]!._open();
    FakeWebSocket.instances[0]!._close(4004);
    expect(events).toEqual(['open', 'terminal:4004']);
    await advance(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    // 也不该走「网络抖动」分支
    expect(events).not.toContain('network');
  });

  it('网络抖动断线：onNetworkClose 后按固定间隔自动重连', async () => {
    await openSettled();
    const ws = FakeWebSocket.instances[0]!;
    ws._open();
    ws._close(1006); // 网络不可达等非终止关闭码
    expect(events).toEqual(['open', 'network']);
    expect(FakeWebSocket.instances).toHaveLength(1); // 尚未重连
    await advance(2999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await advance(1);
    expect(FakeWebSocket.instances).toHaveLength(2); // 3000ms 后重连
    FakeWebSocket.instances[1]!._open();
    expect(events).toEqual(['open', 'network', 'open']);
  });

  it('连续断线：每次网络关闭都重新进入重连周期', async () => {
    await openSettled();
    FakeWebSocket.instances[0]!._open();
    FakeWebSocket.instances[0]!._close(1006);
    await advance(3000);
    FakeWebSocket.instances[1]!._open();
    FakeWebSocket.instances[1]!._close(1006);
    await advance(3000);
    expect(FakeWebSocket.instances).toHaveLength(3);
    expect(events.filter((e) => e === 'network')).toHaveLength(2);
  });

  it('close：主动关闭后断线不再重连，当前连接 onclose 被抑制', async () => {
    await openSettled();
    FakeWebSocket.instances[0]!._open();
    s.close();
    FakeWebSocket.instances[0]!._close(1006);
    expect(events).toEqual(['open']);
    await advance(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('close：重连等待期间取消定时器', async () => {
    await openSettled();
    FakeWebSocket.instances[0]!._open();
    FakeWebSocket.instances[0]!._close(1006);
    s.close();
    await advance(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('open：终止后再次调用被抑制（会话已结束）', async () => {
    await openSettled();
    FakeWebSocket.instances[0]!._close(4003);
    s.open();
    await settle();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  // ============================================================
  // 凭证：一次性票据 / token 回退 / 访客 / 平台分支
  // ============================================================

  it('★ 登录用户用一次性票据建连，URL 里不再出现 JWT', async () => {
    localStorage.setItem('k_token', 'a b&c');
    vi.mocked(fetchVoiceTicket).mockResolvedValue({ ticket: 'tk 1&2' });

    await openSettled();

    const url = FakeWebSocket.instances[0]!.url;
    expect(url).toBe('ws://localhost:3000/api/voice/ws?ticket=tk%201%262');
    expect(url).not.toContain('token=');
    expect(fetchVoiceTicket).toHaveBeenCalledTimes(1);
  });

  it('★ 票据换不到时回退 ?token=（弱网/后端抖动不该让语音整条断掉）', async () => {
    localStorage.setItem('k_token', 'a b&c');
    vi.mocked(fetchVoiceTicket).mockRejectedValue(new Error('network down'));

    await openSettled();

    expect(FakeWebSocket.instances[0]!.url).toBe('ws://localhost:3000/api/voice/ws?token=a%20b%26c');
  });

  it('票据为空串时也回退 ?token=', async () => {
    localStorage.setItem('k_token', 'jwt-value');
    vi.mocked(fetchVoiceTicket).mockResolvedValue({ ticket: '' });

    await openSettled();

    expect(FakeWebSocket.instances[0]!.url).toBe('ws://localhost:3000/api/voice/ws?token=jwt-value');
  });

  it('★ 每次重连都换一张新票据（一次性票据不能复用）', async () => {
    localStorage.setItem('k_token', 'jwt-value');
    vi.mocked(fetchVoiceTicket)
      .mockResolvedValueOnce({ ticket: 'tk-first' })
      .mockResolvedValueOnce({ ticket: 'tk-second' });

    await openSettled();
    expect(FakeWebSocket.instances[0]!.url).toContain('ticket=tk-first');

    FakeWebSocket.instances[0]!._open();
    FakeWebSocket.instances[0]!._close(1006); // 网络抖动
    await advance(3000);

    expect(FakeWebSocket.instances[1]!.url).toContain('ticket=tk-second');
    expect(fetchVoiceTicket).toHaveBeenCalledTimes(2);
  });

  it('★ 取票据期间被 close()：不再建连（避免留下无主连接）', async () => {
    localStorage.setItem('k_token', 'jwt-value');
    let release: (v: { ticket: string }) => void = () => {};
    vi.mocked(fetchVoiceTicket).mockReturnValue(
      new Promise<{ ticket: string }>((resolve) => {
        release = resolve;
      })
    );

    s.open();
    await settle();
    expect(FakeWebSocket.instances).toHaveLength(0); // 票据还没回来

    s.close();
    release({ ticket: 'tk-late' });
    await settle();
    expect(FakeWebSocket.instances).toHaveLength(0); // 已关闭 → 不建连
  });

  it('未登录访客不请求票据（访客不需要凭证）', async () => {
    localStorage.removeItem('k_token');
    await openSettled();
    expect(fetchVoiceTicket).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances[0]!.url).not.toContain('ticket');
    expect(FakeWebSocket.instances[0]!.url).not.toContain('token');
  });

  it('★ 空 token 视为访客：不发 `?token=` 空串（空凭证会进访问日志）', async () => {
    localStorage.setItem('k_token', '');
    await openSettled();
    const url = FakeWebSocket.instances[0]!.url;
    expect(url).toBe('ws://localhost:3000/api/voice/ws');
    expect(fetchVoiceTicket).not.toHaveBeenCalled();
  });

  it('平台分支：原生端直连配置的服务器（http→ws / https→wss）', async () => {
    localStorage.setItem('k_token', 'jwt-value');
    vi.mocked(getServerUrl).mockReturnValue('');
    vi.mocked(fetchVoiceTicket).mockResolvedValue({ ticket: 'tk' });

    // 网页端（location 由 jsdom 提供，http://localhost:3000）
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    await openSettled();
    expect(FakeWebSocket.instances[0]!.url).toBe('ws://localhost:3000/api/voice/ws?ticket=tk');

    // 原生端：http 服务器 → ws://
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(getServerUrl).mockReturnValue('http://192.168.1.5:3000');
    await openSettled(new WsSignaling(opts));
    expect(FakeWebSocket.instances[1]!.url).toBe('ws://192.168.1.5:3000/api/voice/ws?ticket=tk');

    // 原生端：https 服务器 → wss://
    vi.mocked(getServerUrl).mockReturnValue('https://voice.example.com');
    await openSettled(new WsSignaling(opts));
    expect(FakeWebSocket.instances[2]!.url).toBe('wss://voice.example.com/api/voice/ws?ticket=tk');
  });
});
