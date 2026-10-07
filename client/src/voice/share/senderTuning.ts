/**
 * ============================================================
 * 屏幕共享 · 发送端参数调优（voice/share/senderTuning）
 * ============================================================
 * 自 VoiceSession.ts 抽出（纯搬移，行为逐字不变）。
 *
 * 为什么单独成模块：这几个函数**完全不依赖会话状态** —— 输入是
 * RTCRtpTransceiver / RTCRtpSender 与两个档位值，输出是对 WebRTC 的调用，
 * 因此可以从编排根里摘出来、并被单测直接覆盖。此前它们是 VoiceSession 的
 * 私有方法，只能间接验证；而「共享画面糊/卡」恰恰是这类参数决定的第一现场
 * （SDP 编解码偏好、码率、分辨率缩放、降级策略）。
 *
 * 调用方（VoiceSession.maybeAttachShareTracks / applyShareQuality）
 * 只负责从 share 状态机取当前档位再传进来。
 * ============================================================
 */

import { SHARE_QUALITY_PRESETS, type ShareQuality } from '../types';

/**
 * 共享视频优先协商 H.264：默认协商到的 VP8 走 libvpx 软编，
 * 1080p60 软编 CPU 扛不住（实测只能编 ~32fps，qualityLimitation=none、
 * 网络零丢包，纯粹编码吞吐瓶颈）。H.264 可命中显卡硬件编码器
 * （NVIDIA NVENC 等），60fps 轻松跑满；各端 H.264 解码也普遍支持。
 * 必须在首次视频协商前设置（addTransceiver 之后、offer 之前）。
 */
export function preferH264ForSender(transceiver: RTCRtpTransceiver): void {
  try {
    const caps = RTCRtpSender.getCapabilities('video');
    const codecs = caps?.codecs ?? [];
    const h264 = codecs.filter((c) => c.mimeType.toLowerCase() === 'video/h264');
    if (h264.length === 0) return; // 无 H264 能力：保持默认（VP8/VP9）
    const rest = codecs.filter((c) => c.mimeType.toLowerCase() !== 'video/h264');
    transceiver.setCodecPreferences([...h264, ...rest]);
  } catch {
    /* 浏览器不支持编解码偏好则忽略 */
  }
}

/**
 * 把当前档位应用到单个视频 sender（码率 / 分辨率缩放 / 降级偏好）。
 *
 * @param sender 共享视频的发送器
 * @param quality 当前清晰度档位（SHARE_QUALITY_PRESETS 的键）
 * @param sharpText 「清晰文字」模式：contentHint=detail，且带宽不足时保分辨率降帧率
 *                  （写代码/文档场景，文字不糊比流畅重要）
 */
export function applyShareQualityToSender(
  sender: RTCRtpSender,
  quality: ShareQuality,
  sharpText: boolean
): void {
  const preset = SHARE_QUALITY_PRESETS[quality];
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    const enc = params.encodings[0]!;
    enc.maxBitrate = preset.maxBitrate;
    // 不设 minBitrate：实测 BWE 对屏幕共享采用内容自适应（静态内容自动压低、
    // 高动态自动爬升），minBitrate 既不生效也无必要，设了反而可能浪费 mesh 上行
    enc.scaleResolutionDownBy = preset.scale;
    // 60fps 档优先保帧率；清晰文字模式优先保分辨率
    (params as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference = sharpText
      ? 'maintain-resolution'
      : preset.degradation;
    sender.setParameters(params).catch(() => {
      /* 浏览器不支持则忽略 */
    });
  } catch {
    /* 参数不支持：按浏览器默认编码 */
  }
}

/** 把当前档位应用到全部视频 sender（档位切换 / 新对端挂载后调用） */
export function applyShareQualityToSenders(
  senders: Iterable<RTCRtpSender | null | undefined>,
  quality: ShareQuality,
  sharpText: boolean
): void {
  for (const sender of senders) {
    if (sender) applyShareQualityToSender(sender, quality, sharpText);
  }
}
