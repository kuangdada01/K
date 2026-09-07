/**
 * ============================================================
 * 语音信令 WebSocket 传输（voice/signaling/wsSignaling）
 * ============================================================
 * 自 VoiceSession.ts 拆出（行为逐行不变）：
 * - wsUrl：token 查询参数、原生端直连配置服务器（http→ws）、
 *   网页端同源限制（https 页面禁 ws://，防混合内容拦截）
 * - open/send/onmessage JSON.parse（坏包静默丢弃）
 * - 断线自动重连（固定间隔，见 RECONNECT_DELAY_MS）
 * - 终止类关闭码（4001 鉴权失败 / 4002 同账号被顶 / 4003 房间已删）
 *   直接结束会话不再重连；其余关闭码视为网络抖动 → onNetworkClose
 *   后按间隔重开
 *
 * 会话层经 WsSignalingOptions 注入：onOpen 发 join 首包、onMessage
 * 消息分发、onTerminalClose/onNetworkClose 会话级处理（teardown/
 * 清对等连接）。传输层不触碰会话内部状态。
 * ============================================================
 */

import { Capacitor } from '@capacitor/core';
import { getServerUrl } from '../../config';

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

  private wsUrl(): string {
    const token = localStorage.getItem('k_token') ?? '';
    const serverUrl = getServerUrl();
    let base: string;
    if (Capacitor.isNativePlatform() && serverUrl) {
      // 仅原生端直连配置的服务器（无混合内容限制）
      base = serverUrl.replace(/^http/, 'ws'); // http→ws / https→wss
    } else {
      // 网页端必须同源：https 页面发起 ws:// 会被浏览器当作混合内容直接拦截
      // （SERVER_URL 烘进网页包曾导致语音信令全灭，网页一律走 location.host）
      base = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
    }
    return `${base}/api/voice/ws?token=${encodeURIComponent(token)}`;
  }

  open(): void {
    if (this.closed) return;
    this.ws = new WebSocket(this.wsUrl());

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
      if (e.code === 4002 || e.code === 4001 || e.code === 4003) {
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
