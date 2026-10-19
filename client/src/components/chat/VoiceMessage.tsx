/**
 * ============================================================
 * 语音消息气泡（Web 播放端）
 * ============================================================
 * Android 负责录制/发送；Web 至少要能**播放**（用户 2026-10-19 确认的范围）。
 *
 * ## 音频怎么取
 * 语音存在服务端 `uploads_private`，`/api/messages/:id/media` 需要 JWT。
 * `<audio src>` 不能带请求头，所以沿用图片那套 [useAuthMediaUrl]：axios 拉 blob →
 * objectURL。60 秒 AAC 约 0.5MB，整段取回后 `<audio>` 本地播放/seek 都很顺。
 *
 * ## 交互（与 Android/QQ 对齐）
 *  · 点气泡 → 播放/暂停；
 *  · 波形上按下/拖动 → 定位；
 *  · `1x / 1.5x / 2x` 倍速循环；
 *  · 「转文字」→ 服务端 ASR（结果落库缓存），展开在波形下面。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Message } from '../../types';
import api from '../../api/http';
import { useAuthMediaUrl } from '../../hooks/useAuthMediaUrl';
import styles from './MessageBubble.module.css';

interface VoiceMessageProps {
  msg: Message;
  isSent: boolean;
}

/** 0:07 / 1:23 */
function formatDuration(ms: number): string {
  // 与 App 参考图一致：2″，不是 0:02
  const seconds = Math.min(60, Math.max(1, Math.round(ms / 1000)));
  return `${seconds}″`;
}

export default function VoiceMessage({ msg, isSent }: VoiceMessageProps) {
  const src = useAuthMediaUrl(msg.audio_url);
  const audioRef = useRef<HTMLAudioElement>(null);

  const [playing, setPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(msg.audio_duration_ms ?? 0);
  const [transcript, setTranscript] = useState<string | null>(msg.audio_text ?? null);
  const [showTranscript, setShowTranscript] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [transcribeFailed, setTranscribeFailed] = useState(false);

  /** 波形：空数组画等高柱（老消息/异常值） */
  const bars = msg.audio_waveform?.length ? msg.audio_waveform : Array.from({ length: 32 }, () => 18);

  // 进度线按帧走（<audio> 的 timeupdate 只有 ~4Hz，会一格一格跳）
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const audio = audioRef.current;
      if (audio) setPositionMs(audio.currentTime * 1000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      void audio.play();
    } else {
      audio.pause();
    }
  }, []);

  const seekTo = useCallback((fraction: number) => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
    const f = Math.max(0, Math.min(1, fraction));
    audio.currentTime = f * audio.duration;
    setPositionMs(f * audio.duration * 1000);
  }, []);

  const onWaveformPointer = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      if (rect.width <= 0) return;
      seekTo((e.clientX - rect.left) / rect.width);
    },
    [seekTo]
  );

  const onWaveformDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      onWaveformPointer(e);
    },
    [onWaveformPointer]
  );

  const onWaveformMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.buttons === 0) return; // 没按住：滑动列表不误触 seek
      onWaveformPointer(e);
    },
    [onWaveformPointer]
  );

  const translate = useCallback(async () => {
    if (showTranscript) {
      setShowTranscript(false);
      return;
    }
    if (transcript !== null) {
      setShowTranscript(true);
      return;
    }
    setTranscribing(true);
    setTranscribeFailed(false);
    try {
      const { data } = await api.post<{ text: string }>(`/messages/${msg.id}/transcribe`);
      setTranscript(data.text || '');
      setShowTranscript(true);
    } catch {
      // 失败不弹窗：按钮变成「转文字失败」提示，再点一次即重试
      setTranscribeFailed(true);
    } finally {
      setTranscribing(false);
    }
  }, [msg.id, showTranscript, transcript]);

  const progress = durationMs > 0 ? Math.min(1, positionMs / durationMs) : 0;
  const width = 120 + 100 * Math.min(1, (msg.audio_duration_ms ?? 0) / 60_000);

  return (
    <>
      <div
        className={`${styles.voiceMessage} ${isSent ? styles.sent : styles.received}`}
        style={{ width: `${width}px` }}
      >
        <div className={styles.voiceRow}>
          <button
            type="button"
            className={styles.voicePlay}
            onClick={toggle}
            aria-label={playing ? '暂停语音' : '播放语音'}
          >
            {playing ? (
              <span className={styles.voicePauseIcon} aria-hidden>
                <i />
                <i />
              </span>
            ) : (
              <span className={styles.voicePlayIcon} aria-hidden />
            )}
          </button>

          <div
            className={styles.waveform}
            onPointerDown={onWaveformDown}
            onPointerMove={onWaveformMove}
            // 父级用 touch 事件做长按菜单；波形拖动必须独占这一片区域
            onTouchStart={(e) => e.stopPropagation()}
            onTouchMove={(e) => e.stopPropagation()}
            role="slider"
            aria-label="语音进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
          >
            {bars.map((value, index) => {
              const played = index < progress * bars.length;
              return (
                <span
                  key={index}
                  className={`${styles.waveBar} ${played ? styles.waveBarPlayed : ''}`}
                  style={{ height: `${Math.max(12, value)}%` }}
                />
              );
            })}
          </div>

          <span className={styles.voiceDuration}>{formatDuration(durationMs)}</span>
        </div>

        <div className={styles.voiceMeta}>
          <button type="button" onClick={translate} className={styles.voiceMetaBtn} disabled={transcribing}>
            {transcribing
              ? '转写中…'
              : showTranscript
                ? '收起'
                : transcript !== null
                  ? '看文字'
                  : transcribeFailed
                    ? '转写失败，重试'
                    : '转文字'}
          </button>
        </div>

        {src && (
          <audio
            ref={audioRef}
            src={src}
            preload="metadata"
            loop={false}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => {
              setPlaying(false);
              setPositionMs(0);
              if (audioRef.current) audioRef.current.currentTime = 0;
            }}
            onTimeUpdate={(e) => setPositionMs(e.currentTarget.currentTime * 1000)}
            onLoadedMetadata={(e) => {
              const d = e.currentTarget.duration;
              if (Number.isFinite(d) && d > 0) setDurationMs(Math.round(d * 1000));
            }}
            hidden
          />
        )}
      </div>
      {showTranscript && <div className={styles.voiceTranscriptBubble}>{transcript || '[未识别到文字]'}</div>}
    </>
  );
}
