/**
 * ============================================================
 * 棋步语音播报 Hook（voice/chess/useChessTTS）
 * ============================================================
 * 复用聊天朗读的能力探测（getTtsSynth/detectTtsSupported —— 残缺内核
 * 如微信 iOS WebView 判不支持，见 useChatTTS.ts 的事故注释）。
 * 与聊天朗读的差异：无消息队列/高亮状态，只有"最新一着打断上一着"。
 * 语言恒为中文（记谱是中文）。
 * ============================================================
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { detectTtsSupported, getTtsSynth } from '../../hooks/useChatTTS';

/** 播报开关的 localStorage 键（同聊天朗读/降噪的偏好持久化惯例） */
const CHESS_TTS_KEY = 'voice:chessTTS';

export function useChessTTS() {
  /** 浏览器是否支持语音合成（不支持时开关置灰） */
  const supported = detectTtsSupported();
  const [enabled, setEnabled] = useState(() => localStorage.getItem(CHESS_TTS_KEY) === '1');
  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);
  const delayRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 手势内预解锁合成引擎：移动端 iOS/安卓要求首次 speak 发生在用户手势里，
   *  否则之后的程序化播报会被静默拦截（空文本 0 音量，听不见） */
  const prime = useCallback(() => {
    const synth = getTtsSynth();
    if (!synth || typeof SpeechSynthesisUtterance !== 'function') return;
    try {
      synth.cancel();
      const utter = new SpeechSynthesisUtterance(' ');
      utter.volume = 0;
      synth.speak(utter);
    } catch {
      /* 静默 */
    }
  }, []);

  const toggle = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev;
      localStorage.setItem(CHESS_TTS_KEY, next ? '1' : '0');
      if (next) {
        prime(); // 开启即解锁（本次点击就是手势）
      } else {
        // 关闭时打断在播的着法（含延迟队列）
        if (delayRef.current !== null) {
          clearTimeout(delayRef.current);
          delayRef.current = null;
        }
        getTtsSynth()?.cancel();
      }
      return next;
    });
  }, [prime]);

  /** 播报一条着法（"红方炮二平五，将军"）；开关关闭/不支持时静默跳过 */
  const announce = useCallback((text: string) => {
    if (!enabledRef.current) return;
    const synth = getTtsSynth();
    if (!synth || typeof SpeechSynthesisUtterance !== 'function') return;
    synth.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'zh-CN';
    const voice = synth.getVoices?.().find((v) => v.lang.toLowerCase().startsWith('zh'));
    if (voice) utter.voice = voice;
    // 同聊天朗读：cancel 后立即 speak 可能静默失败，延迟一个宏任务
    if (delayRef.current !== null) clearTimeout(delayRef.current);
    delayRef.current = setTimeout(() => {
      delayRef.current = null;
      synth.speak(utter);
    }, 0);
  }, []);

  useEffect(() => {
    return () => {
      if (delayRef.current !== null) clearTimeout(delayRef.current);
    };
  }, []);

  return { supported, enabled, toggle, announce };
}
