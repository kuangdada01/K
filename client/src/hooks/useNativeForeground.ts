/**
 * ============================================================
 * 后台音频保活 Hook（hooks/useNativeForeground）
 * ============================================================
 * 一个前台服务，两个来源（语音房 / 音乐播放）——**取优先级最高的那个**作为通知文案：
 * 语音房 > 音乐。两边都停就撤服务。
 *
 * 为什么必须这么做（不是可选优化）：
 * - Android 14+ 规定后台麦克风采集必须由带 `microphone` 类型的前台服务持有，
 *   否则系统直接把语音房的麦克风静音（用户表现为"切出去就听不到我说话了"）；
 * - 音乐/语音房在后台继续跑也需要前台服务，否则进程随时可能被回收（SSE 一起断）。
 *
 * 同时处理原生来的命令：
 * - `stop`（通知栏"停止"）→ 语音房就退房、否则暂停音乐；
 * - `pause`/`audioFocusLost`（被别的播放器抢焦点）→ 暂停音乐，并记住"是系统让我停的"；
 * - `resume` → 只有确实是系统暂停的才恢复（用户手动暂停的不该被恢复）。
 * ============================================================
 */

import { useEffect, useRef } from 'react';
import { useMusic } from '../context/MusicContext';
import { useVoice } from '../context/VoiceContext';
import {
  isNative,
  onMediaCommand,
  startBackgroundPlayback,
  stopBackgroundPlayback,
  updateBackgroundPlayback,
} from '../lib/native';

export function useNativeForeground(): void {
  const { inRoom, activeRoomName, leave } = useVoice();
  const { isPlaying, currentSong, play, pause } = useMusic();

  /** 语音房进行中 */
  const voiceActive = isNative() && inRoom;

  // 起/停前台服务：语音房优先，其次音乐
  useEffect(() => {
    if (!isNative()) return;
    if (voiceActive) {
      void startBackgroundPlayback('voice', activeRoomName || '语音房', '语音房中').catch(() => {});
      return;
    }
    if (isPlaying) {
      const title = currentSong?.title || '音乐';
      const text = currentSong?.artist ? currentSong.artist : '正在播放';
      void startBackgroundPlayback('music', title, text).catch(() => {});
      return;
    }
    void stopBackgroundPlayback().catch(() => {});
  }, [voiceActive, isPlaying, activeRoomName, currentSong?.title, currentSong?.artist]);

  // 切歌/改房名时更新通知文案（不重启服务）
  useEffect(() => {
    if (!isNative() || voiceActive) return;
    if (!isPlaying) return;
    const title = currentSong?.title || '音乐';
    const text = currentSong?.artist ? currentSong.artist : '正在播放';
    void updateBackgroundPlayback(title, text).catch(() => {});
  }, [voiceActive, isPlaying, currentSong?.title, currentSong?.artist]);

  // 离开页面/卸载时撤掉服务，避免"App 都关了通知栏还挂着"
  useEffect(() => {
    return () => {
      if (isNative()) void stopBackgroundPlayback().catch(() => {});
    };
  }, []);

  /** 是否由系统（音频焦点）暂停的：只在这种情况才自动恢复 */
  const pausedByFocusRef = useRef(false);

  useEffect(() => {
    if (!isNative()) return;
    return onMediaCommand(({ action }) => {
      if (action === 'stop') {
        if (inRoom) leave();
        else pause();
        return;
      }
      if (action === 'pause' || action === 'audioFocusLost') {
        if (isPlaying) {
          pausedByFocusRef.current = true;
          pause();
        }
        return;
      }
      if (action === 'resume') {
        if (pausedByFocusRef.current) {
          pausedByFocusRef.current = false;
          play();
        }
      }
      // duck：网页音频无法真正"压低"，忽略（系统会自己降音量）
    });
  }, [inRoom, leave, isPlaying, play, pause]);
}
