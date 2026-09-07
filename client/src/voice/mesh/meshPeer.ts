/**
 * ============================================================
 * Mesh 对端条目类型（voice/mesh/meshPeer）
 * ============================================================
 * 自 VoiceSession.ts 拆出（结构逐字段不变）：单条对等连接的全部
 * 会话状态（参与者信息、PC、音频节点、完美协商/ICE 重启记账）。
 * ============================================================
 */

import type { VoiceParticipant } from '../../types';
import type { PeerAudio } from '../audio/audioGraph';

/** Mesh 成员条目 */
export interface PeerEntry {
  participant: VoiceParticipant;
  pc: RTCPeerConnection;
  audio: PeerAudio | null; // ontrack 后创建（音频图节点，见 ./audio/audioGraph.ts）
  pendingCandidates: RTCIceCandidateInit[]; // 远端描述就绪前缓存的候选
  remoteDescSet: boolean;
  /** 上次统计的累计丢包/收包（丢包率按窗口增量计算，避免早期网络高峰永久拖累显示） */
  lastPacketsLost: number;
  lastPacketsReceived: number;
  /** 完美协商角色：userId 大者为 polite（offer 冲突时回滚让步，小者坚持己见） */
  polite: boolean;
  makingOffer: boolean; // 本端 createOffer/setLocalDescription 进行中（冲突检测用）
  /** 完美协商冲突时被本端"忽略"的远端 offer：本端协商落定（stable）后补处理。
   *  修复"进房间加载不出共享画面"：共享者的补挂重协商 offer 紧跟初始 answer 到达，
   *  非礼貌方若仍在消化 answer（signalingState 未回 stable）会按冲突丢弃它且对端不会重发，
   *  导致共享画面永久缺失——暂存后补处理即可收敛。 */
  pendingOffer: { sdp: string } | null;
  negotiateSuppressed: boolean; // 抑制初始 negotiationneeded（初始 offer 由新加入者确定性发起）
  videoSender: RTCRtpSender | null; // 我共享屏幕时发给该对端的视频 sender
  shareAudioSender: RTCRtpSender | null; // 我共享屏幕时的系统声音 sender
  micStreamId: string | null; // 该对端麦克风音频流 id（此后同对端新音频流 = 共享系统声音）
  audioTransceiver: RTCRtpTransceiver | null; // 本端麦克风音频收发器（RED/Opus 编解码偏好挂载点）
  /** 上次统计的累计丢包隐藏样本/总接收样本（隐藏率按窗口增量计算，避免历史劣化永久拖累显示） */
  lastConcealedSamples: number;
  lastTotalSamples: number;
}
