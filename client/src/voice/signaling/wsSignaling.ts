/**
 * ============================================================
 * 语音信令 WebSocket 传输（voice/signaling/wsSignaling）
 * ============================================================
 * 自 VoiceSession.ts 拆出（行为逐行不变）：
 * - wsUrl：凭证参数、原生端直连配置服务器（http→ws）、
 *   网页端同源限制（https 页面禁 ws://，防混合内容拦截）
 * - open/send/onmessage JSON.parse（坏包静默丢弃）
 * - 断线自动重连（固定间隔，见 RECONNECT_DELAY_MS）
 * - 终止类关闭码（4001 鉴权失败 / 4002 同账号被顶 / 4003 房间已删 /
 *   4004 同 IP 连接过多）直接结束会话不再重连；其余关闭码视为网络抖动 →
 *   onNetworkClose 后按间隔重开
 *
 *   4004 必须是终止类：否则客户端会按 3s 间隔不断重连一个**必然被拒**的服务端，
 *   变成自己制造的重试风暴。
 *
 * 凭证：登录用户先用 Bearer 换一张**一次性票据**（`?ticket=`），JWT 不再进 URL
 * （会进 nginx access log）；取不到票据时回退旧的 `?token=`，保证弱网/后端抖动
 * 不影响可用性。访客不带任何凭证。票据只能用一次，因此每次建连都重新换取。
 *
 * 会话层经 WsSignalingOptions 注入：onOpen 发 join 首包、onMessage
 * 消息分发、onTerminalClose/onNetworkClose 会话级处理（teardown/
 * 清对等连接）。传输层不触碰会话内部状态。
 * ============================================================
 */

import { Capacitor } from '@capacitor/core';
import { getServerUrl } from '../../config';
import { fetchVoiceTicket } from '../../api/voice';

/** 断线重连间隔（网络抖动等非终止关闭码） */
const RECONNECT_DELAY_MS = 3000;

export interface WsSignalingOptions {
  /** 连接建立后回调（发送 join 首包等） */
  onOpen(): void;
  /** 收到合法 JSON 消息（坏包已在传输层丢弃） */
  onMessage(msg: unknown): void;
  /** 终止类关闭码（4001/4002/4003）：会话随关闭码结束，不再重连 */
  onTerminalClose(code: number): void;
  /** 网络抖动断线：会话清理对等连接等，随后按间隔自动重连 */
  onNetworkClose(): void;
}

/** 信令 WS 传输（新建对象即未连接；open() 启动连接与自动重连） */
export class WsSignaling {
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  /** 已终止（会话销毁/主动关闭/终止类关闭码）：不再重连 */
  private closed = false;

  constructor(private opts: WsSignalingOptions) {}

  /** 信令基址（协议 + 主机；不含路径与凭证） */
  private wsBase(): string {
    const serverUrl = getServerUrl();
    if (Capacitor.isNativePlatform() && serverUrl) {
      // 仅原生端直连配置的服务器（无混合内容限制）
      return serverUrl.replace(/^http/, 'ws'); // http→ws / https→wss
    }
    // 网页端必须同源：https 页面发起 ws:// 会被浏览器当作混合内容直接拦截
    // （SERVER_URL 烘进网页包曾导致语音信令全灭，网页一律走 location.host）
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
  }

  /** 拼接建连 URL；query 为 null 表示访客（不带任何凭证参数） */
  private wsUrl(query: string | null): string {
    const base = this.wsBase();
    return query ? `${base}/api/voice/ws?${query}` : `${base}/api/voice/ws`;
  }

  /**
   * 取本次建连的凭证查询串。
   * - 未登录 → null（访客直连，不发空凭证 —— 空串会进访问日志）
   * - 登录 → 先换一次性票据（JWT 不进 URL）；换不到再回退旧的 `?token=`，
   *   只为可用性兜底（弱网/后端抖动时语音不该整条断掉）
   */
  private async resolveCredential(): Promise<string | null> {
    const token = localStorage.getItem('k_token');
    if (!token) return null;
    try {
      const { ticket } = await fetchVoiceTicket();
      if (ticket) return `ticket=${encodeURIComponent(ticket)}`;
    } catch {
      /* 落到 token 回退 */
    }
    return `token=${encodeURIComponent(token)}`;
  }

  open(): void {
    if (this.closed) return;
    // 票据要先用 Bearer 去换，因此建连是异步的；期间可能已被 close()
    void this.openAsync();
  }

  private async openAsync(): Promise<void> {
    let query: string | null = null;
    try {
      query = await this.resolveCredential();
    } catch {
      query = null;
    }
    if (this.closed) return; // 取票据期间会话已关闭：不要再建连
    this.connect(this.wsUrl(query));
  }

  private connect(url: string): void {
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.opts.onOpen();
    };

    this.ws.onmessage = (e) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return; // 坏包静默丢弃
      }
      this.opts.onMessage(msg);
    };

    this.ws.onclose = (e) => {
      this.ws = null;
      if (this.closed) return;
      // 主动踢出类关闭码直接结束会话（不再重连）
      if (e.code === 4002 || e.code === 4001 || e.code === 4003 || e.code === 4004) {
        this.closed = true;
        this.opts.onTerminalClose(e.code);
        return;
      }
      // 其余（网络抖动等）：清理由会话层完成，随后自动重连
      this.opts.onNetworkClose();
      this.reconnectTimer = window.setTimeout(() => this.open(), RECONNECT_DELAY_MS);
    };
  }

  /** 连接是否就绪（可发信令） */
  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(msg: unknown): boolean {
    if (!this.isOpen()) return false;
    this.ws!.send(JSON.stringify(msg));
    return true;
  }

  /** 主动关闭（leave/teardown）：终止重连并断开当前连接（1000 正常关闭） */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close(1000);
      } catch {
        /* 已关闭 */
      }
      this.ws = null;
    }
  }
}
