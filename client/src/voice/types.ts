/**
 * ============================================================
 * 语音模块共享类型与常量（voice/types）
 * ============================================================
 * 从 VoiceSession.ts 抽出：UI 层（VoiceContext/VoicePage/VoiceShareStage）与
 * 会话类共用的类型、质量档位预设。VoiceSession.ts 对本模块做 re-export，
 * 既有 `from '../voice/VoiceSession'` 的导入路径保持不变。
 */

import type { VoiceChatMessage, VoiceParticipant } from '../types';

export type VoiceStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'ended';

/** 语音质量等级（每个成员自报自身网络状况，服务器广播给全房间展示） */
export type VoiceQualityLevel = 'good' | 'fair' | 'poor';

/** 屏幕共享质量档位（极清 = 1080p60；mesh 上行 = 观看数 × 码率，人多建议降档） */
export type ShareQuality = '1080p60' | '1080p30' | '720p30';

/** 质量档位 → 编码参数（scale 分辨率下采样倍率；degradation 带宽不足时的降级策略）。
 *  码率上限给足：实际发送码率由 WebRTC 按网络可用带宽自适应（0 ~ 上限），
 *  mesh 拓扑下共享者上行 = 观看数 × 实际码率。 */
export const SHARE_QUALITY_PRESETS: Record<
  ShareQuality,
  {
    maxBitrate: number;
    scale: number;
    degradation: 'maintain-framerate' | 'maintain-resolution' | 'balanced';
  }
> = {
  // 1080p60 动态画面（视频/游戏）实测 BWE 自适应会给到 12M 上下，上限给足让拥塞控制按需取值
  '1080p60': { maxBitrate: 30_000_000, scale: 1, degradation: 'maintain-framerate' },
  // 1080p30 动态画面实测会顶满 8M 上限仍偏紧（高动态内容 10M 才接近清晰），提到 10M
  '1080p30': { maxBitrate: 10_000_000, scale: 1, degradation: 'balanced' },
  '720p30': { maxBitrate: 6_000_000, scale: 1.5, degradation: 'balanced' },
};

/** 发送端共享画面实时统计（采样自 video outbound-rtp，仅共享者有意义） */
export interface ShareStats {
  /** 编码后实际发送帧率（非捕获帧率；编码瓶颈/窗口共享都会低于 60，0=暂无数据） */
  fps: number;
  /** 实际发送码率 bps（窗口增量均值，0=暂无数据） */
  bitrate: number;
  /** 发送分辨率（带宽/CPU 不足时编码器会缩小，画面糊的直接信号） */
  width: number;
  height: number;
  /** 捕获分辨率（getDisplayMedia 协商结果） */
  captureWidth: number;
  captureHeight: number;
  /** 编码受限原因：none | cpu | bandwidth | other */
  limitation: string;
  /** 捕获源实际帧率（窗口/标签共享被浏览器限制为 30，整屏共享才到 60） */
  captureFps: number;
  /** 1080p60 档因 CPU 编码瓶颈被自动降为 1080p30（一次共享会话只触发一次） */
  autoDowngraded: boolean;
  /** 发送分辨率被带宽降级（观众看到糊画面） */
  resolutionDownscaled: boolean;
}

/** 屏幕共享发起结果（cancelled 含用户在浏览器选择器里取消） */
export type ScreenShareStartResult = 'started' | 'cancelled' | 'unsupported';

export interface VoiceSelfInfo {
  userId: number;
  username: string;
  avatar: string | null;
}

export interface VoiceSessionCallbacks {
  /** 连接状态变化 */
  onStatus: (status: VoiceStatus, detail?: string) => void;
  /** 参与者列表变化（含自己，自己在首位） */
  onParticipants: (participants: VoiceParticipant[]) => void;
  /** 说话状态翻转（含自己） */
  onSpeaking: (userId: number, speaking: boolean) => void;
  /** 可恢复错误（房间满/房间不存在等，会话已终止） */
  onError: (message: string) => void;
  /** 会话被外部终止（房间被删/账号在别处登录/认证失败） */
  onClosed: (reason: string) => void;
  /** 某成员的网络质量更新（数据源为服务器广播的各成员自报值；level=null 表示清除该成员的残留状态） */
  onPeerQuality: (userId: number, level: VoiceQualityLevel | null) => void;
  /** 全房间录制状态翻转（startedAt 为开始时间戳，停止时为 null） */
  onRecordingChange: (isRecording: boolean, startedAt: number | null) => void;
  /** 屏幕共享状态变化（userId=null 表示共享结束；audio=共享是否携带系统声音） */
  onShareChanged: (info: { userId: number | null; audio: boolean }) => void;
  /** 待渲染的共享画面流（共享者=本地捕获流，观看者=远端流；null=无画面） */
  onShareVideo: (stream: MediaStream | null) => void;
  /** 发送端共享画面实时统计（共享中每 2s 更新，null=未共享）。仅共享者端有数据 */
  onShareStats: (stats: ShareStats | null) => void;
  /** 共享质量档位变化（含"1080p60 编码瓶颈自动降档"这类内部触发的档位变更） */
  onShareQualityChange?: (q: ShareQuality) => void;
  /** 收到新聊天消息（服务器广播，含自己发送的；客户端按 id 去重/回显） */
  onChatMessage: (message: VoiceChatMessage) => void;
  /** 聊天记录被房主/管理员清空（本地列表应即时清空） */
  onChatCleared: () => void;
}
