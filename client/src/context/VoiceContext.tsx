/**
 * ============================================================
 * 语音会话全局上下文 (VoiceContext)
 * ============================================================
 * 会话挂在应用根部而非 VoicePage 组件：
 * 切换页面不退出房间，仅在主动退出 / 关闭网页 / 登出时断开。
 *
 * 刷新页面：sessionStorage 记录活跃房间（关闭标签页即清除），
 * 应用加载后自动静默回到房间，配合 VoiceSession 的
 * "首次交互恢复音频" 兜底实现"关掉网址才真正断开"。
 *
 * §3.3 拆分后本文件为组合层：
 * - useVoiceSessionController：sessionRef/状态桥接/全部控制动作
 * - useVoiceChatStore：聊天拉取/去重/翻页（动作经 ref 注入控制器，
 *   避免两个 hook 的初始化顺序循环依赖）
 * 四个导出 hook 签名不变（useVoice/useVoiceRealtime/useVoiceChat/
 * useVoiceInRoom）。
 */

import { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import { useAuth } from './AuthContext';
import {
  useVoiceSessionController,
  type SessionChatActions,
  type VoiceShareState,
} from '../hooks/useVoiceSessionController';
import { useVoiceChatStore } from '../hooks/useVoiceChatStore';
import type { VoiceStatus, VoiceQualityLevel, ShareQuality, ShareStats } from '../voice/VoiceSession';
import type { VoiceChatMessage, VoiceParticipant } from '../types';

export type { VoiceShareState } from '../hooks/useVoiceSessionController';

export interface VoiceContextValue {
  status: VoiceStatus;
  participants: VoiceParticipant[];
  /** 高频字段已移到 VoiceRealtimeContext，通过 useVoiceRealtime() 获取；此处保留类型标注保证 useVoice() 兼容字段读取（已废弃，请迁移） */
  speaking?: Set<number>;
  peerQuality?: Record<number, VoiceQualityLevel>;
  inRoom: boolean;
  activeRoomId: number | null;
  activeRoomName: string | null;
  join: (roomId: number, roomName?: string) => void;
  leave: () => void;
  toggleMute: () => void;
  /** 全房间录制：开 = 录远端各路 + 开麦时的自己；关 = 转码 MP3 自动下载 */
  toggleRecording: () => void;
  isRecording: boolean;
  recordingStartedAt: number | null;
  setMicVolume: (v: number) => void;
  setPeerVolume: (userId: number, v: number) => void;
  getPeerVolume: (userId: number) => number;
  getMicVolume: () => number;
  /** 麦克风降噪开关（默认关） */
  noiseReduction: boolean;
  toggleNoiseReduction: () => void;
  /** 音乐模式（默认关）：96k 立体声 + 关闭回声消除/降噪，播音乐/唱歌时开 */
  musicMode: boolean;
  toggleMusicMode: () => void;
  /** 屏幕共享（全房间唯一共享者，抢占式；null = 无人共享） */
  share: VoiceShareState | null;
  /** 发送端共享画面实时统计（帧率/码率/分辨率/降级原因；仅共享者端有数据）——已移到 useVoiceRealtime() */
  shareStats?: ShareStats | null;
  /** 浏览器是否支持屏幕捕获（不支持时 UI 隐藏入口） */
  canScreenShare: boolean;
  toggleScreenShare: () => void;
  shareQuality: ShareQuality;
  setShareQuality: (q: ShareQuality) => void;
  shareSharpText: boolean;
  toggleShareSharpText: () => void;
  /** 接收端共享声音开关（默认静音，符合自动播放策略） */
  shareMuted: boolean;
  toggleShareMuted: () => void;
  // 文字聊天字段（messages/chatHasMore/chatLoadingMore/sendChat/loadMoreChat/liveMessage）
  // 已移到 VoiceChatContext，通过 useVoiceChat() 获取——每条聊天消息到达都会更新它们，
  // 若留在主 value 会连带全站订阅者重渲染。
}

// P5 拆包：高频状态（speaking / peerQuality / shareStats，每秒数次更新）单独放
// 一个 context，主 VoiceContext 内不再包含它们。这样只有使用 useVoiceRealtime()
// 的组件（语音页面/共享舞台）才会随连续说话状态重渲染，其余只是读 inRoom 的
// PostCard/Sidebar/CreatePost 不受影响。
const VoiceContext = createContext<VoiceContextValue | null>(null);
const VoiceRealtimeContext = createContext<{
  speaking: Set<number>;
  peerQuality: Record<number, VoiceQualityLevel>;
  shareStats: ShareStats | null;
} | null>(null);

/** 文字聊天 context：每条消息到达都会更新的高频字段单独放，
 *  只有语音页的聊天面板订阅它，其余 useVoice() 消费者不受刷屏影响 */
export interface VoiceChatContextValue {
  /** 消息按时间正序（末尾最新），持久化在服务端，房间删除时级联清理 */
  messages: VoiceChatMessage[];
  /** 是否还有更早的历史可向上翻页 */
  chatHasMore: boolean;
  /** 正在向上加载更早的聊天记录 */
  chatLoadingMore: boolean;
  /** 发送文字消息（走信令通道，与 WebRTC 语音媒体分离，语音差时文字仍可用）；返回是否成功发出 */
  sendChat: (content: string) => boolean;
  /** 向上翻页加载更早的聊天记录（自动按首条消息 id 定位） */
  loadMoreChat: () => void;
  /** 最近一条实时到达的聊天消息（仅 WS 实时广播触发，历史补拉不触发；null=暂无） */
  liveMessage: VoiceChatMessage | null;
}
const VoiceChatContext = createContext<VoiceChatContextValue | null>(null);

export function VoiceProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();

  // 聊天动作经 ref 注入会话控制器（join/leave 等运行期读取，避免初始化顺序循环依赖）
  const chatActionsRef = useRef<SessionChatActions>({
    onChatMessage: () => {},
    onChatCleared: () => {},
    reset: () => {},
  });
  const sessionController = useVoiceSessionController(user, () => chatActionsRef.current);
  const chatStore = useVoiceChatStore({
    status: sessionController.status,
    activeRoomId: sessionController.activeRoomId,
  });
  useEffect(() => {
    chatActionsRef.current = {
      onChatMessage: chatStore.onChatMessage,
      onChatCleared: chatStore.onChatCleared,
      reset: chatStore.reset,
    };
  }, [chatStore.onChatMessage, chatStore.onChatCleared, chatStore.reset]);

  // P5 修复：主值用 useMemo 稳定化（依赖列表体现真实变化），高频 speaking/peerQuality/shareStats
  // 拆到 VoiceRealtimeContext，避免整个订阅树随说话状态每秒多次重渲染。
  const voiceValue = useMemo<VoiceContextValue>(
    () => ({
      status: sessionController.status,
      participants: sessionController.participants,
      inRoom:
        sessionController.status === 'connecting' ||
        sessionController.status === 'connected' ||
        sessionController.status === 'reconnecting',
      activeRoomId: sessionController.activeRoomId,
      activeRoomName: sessionController.activeRoomName,
      join: sessionController.join,
      leave: sessionController.leave,
      toggleMute: sessionController.toggleMute,
      toggleRecording: sessionController.toggleRecording,
      isRecording: sessionController.isRecording,
      recordingStartedAt: sessionController.recordingStartedAt,
      setMicVolume: sessionController.setMicVolume,
      setPeerVolume: sessionController.setPeerVolume,
      getPeerVolume: sessionController.getPeerVolume,
      getMicVolume: sessionController.getMicVolume,
      noiseReduction: sessionController.noiseReduction,
      toggleNoiseReduction: sessionController.toggleNoiseReduction,
      musicMode: sessionController.musicMode,
      toggleMusicMode: sessionController.toggleMusicMode,
      share: sessionController.share,
      canScreenShare: sessionController.canScreenShare,
      toggleScreenShare: sessionController.toggleScreenShare,
      shareQuality: sessionController.shareQuality,
      setShareQuality: sessionController.setShareQuality,
      shareSharpText: sessionController.shareSharpText,
      toggleShareSharpText: sessionController.toggleShareSharpText,
      shareMuted: sessionController.shareMuted,
      toggleShareMuted: sessionController.toggleShareMuted,
    }),
    [
      sessionController.status,
      sessionController.participants,
      sessionController.activeRoomId,
      sessionController.activeRoomName,
      sessionController.join,
      sessionController.leave,
      sessionController.toggleMute,
      sessionController.toggleRecording,
      sessionController.isRecording,
      sessionController.recordingStartedAt,
      sessionController.setMicVolume,
      sessionController.setPeerVolume,
      sessionController.getPeerVolume,
      sessionController.getMicVolume,
      sessionController.noiseReduction,
      sessionController.toggleNoiseReduction,
      sessionController.musicMode,
      sessionController.toggleMusicMode,
      sessionController.share,
      sessionController.canScreenShare,
      sessionController.toggleScreenShare,
      sessionController.shareQuality,
      sessionController.setShareQuality,
      sessionController.shareSharpText,
      sessionController.toggleShareSharpText,
      sessionController.shareMuted,
      sessionController.toggleShareMuted,
    ]
  );

  const realtimeValue = useMemo(
    () => ({
      speaking: sessionController.speaking,
      peerQuality: sessionController.peerQuality,
      shareStats: sessionController.shareStats,
    }),
    [sessionController.speaking, sessionController.peerQuality, sessionController.shareStats]
  );

  const chatValue = useMemo<VoiceChatContextValue>(
    () => ({
      messages: chatStore.messages,
      chatHasMore: chatStore.chatHasMore,
      chatLoadingMore: chatStore.chatLoadingMore,
      sendChat: sessionController.sendChat,
      loadMoreChat: chatStore.loadMoreChat,
      liveMessage: chatStore.liveMessage,
    }),
    [
      chatStore.messages,
      chatStore.chatHasMore,
      chatStore.chatLoadingMore,
      sessionController.sendChat,
      chatStore.loadMoreChat,
      chatStore.liveMessage,
    ]
  );

  return (
    <VoiceContext.Provider value={voiceValue}>
      <VoiceChatContext.Provider value={chatValue}>
        <VoiceRealtimeContext.Provider value={realtimeValue}>{children}</VoiceRealtimeContext.Provider>
      </VoiceChatContext.Provider>
    </VoiceContext.Provider>
  );
}

export function useVoice(): VoiceContextValue {
  const ctx = useContext(VoiceContext);
  if (!ctx) throw new Error('useVoice 必须在 VoiceProvider 内使用');
  return ctx;
}

/** 只订阅实时高频状态（说话/网络质量/共享统计）。低频组件不应调用它。 */
export function useVoiceRealtime(): {
  speaking: Set<number>;
  peerQuality: Record<number, VoiceQualityLevel>;
  shareStats: ShareStats | null;
} {
  const realtime = useContext(VoiceRealtimeContext);
  if (!realtime) throw new Error('useVoiceRealtime 必须在 VoiceProvider 内使用');
  return realtime;
}

/** 订阅文字聊天高频字段（messages/liveMessage 等）。只在语音页聊天面板使用。 */
export function useVoiceChat(): VoiceChatContextValue {
  const ctx = useContext(VoiceChatContext);
  if (!ctx) throw new Error('useVoiceChat 必须在 VoiceProvider 内使用');
  return ctx;
}

/** P5：仅读取 inRoom 的精确选择器，不随说话/网络质量等高频状态重渲染。 */
export function useVoiceInRoom(): boolean {
  const ctx = useContext(VoiceContext);
  if (!ctx) throw new Error('useVoiceInRoom 必须在 VoiceProvider 内使用');
  return ctx.inRoom;
}
