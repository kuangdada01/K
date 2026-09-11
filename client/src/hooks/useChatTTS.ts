/**
 * ============================================================
 * 语音聊天朗读 Hook（hooks/useChatTTS）
 * ============================================================
 * 自 VoicePage.tsx 拆出（§3.2），同时修复两处 P2 缺陷：
 * 1. speakingRef 从未置 true → 防重入守卫失效（打开开关瞬间补读/连读竞态）。
 *    修复：派发朗读时立即置位，延迟 speak 前校验「仍是当前 utterance」。
 * 2. cancel 后旧 utterance 的 onend 会清掉新消息高亮（cancel 触发旧 onend 异步
 *    回调，把刚置位的新消息 speakingMsgId 清空）。修复：onend/onerror 带
 *    currentUtterRef 令牌守卫，只认自己这条。
 *
 * 行为不变量（其余）：朗读开关持久化键、语言判定（内容含中文→zh、纯英文→en、
 * 数字→zh）、「用户名说内容」播报格式、自己的消息不自动朗读、页面切后台停止、
 * 退房/卸载停止、新消息打断旧消息（最新优先）、再点同一消息=停止。
 * ============================================================
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { VoiceChatMessage, VoiceParticipant } from '../types';
import { showToast } from '../components/ui/Toast';

/** 朗读开关的 localStorage 键（同降噪/音乐模式的偏好持久化惯例） */
const CHAT_TTS_KEY = 'voice:chatTTS';

/**
 * 判断消息内容语言（只对内容判定，不含用户名，避免英文用户名带偏检测）：
 * - 含中文 → zh（中文优先）
 * - 纯英文字母 → en
 * - 无中文也无字母（纯数字/符号/表情，如 666）→ zh（数字用中文念法："666"→"六六六"）
 */
export function detectSpeakLang(text: string): 'zh' | 'en' {
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? []).length;
  if (cjk > 0) return 'zh';
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  if (latin > 0) return 'en';
  return 'zh';
}

export interface UseChatTTSOptions {
  /** 最新一条实时消息（服务端广播；开关开启时自动朗读非自己发的） */
  liveMessage: VoiceChatMessage | null;
  /** 当前参与者列表（participants[0] = 自己，判断是否本人消息） */
  participants: VoiceParticipant[];
  /** 是否在房间内（退房时立即停止朗读） */
  inRoom: boolean;
}

export function useChatTTS({ liveMessage, participants, inRoom }: UseChatTTSOptions) {
  /** 浏览器是否支持语音合成（不支持时开关置灰） */
  const ttsSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;
  /** 朗读开关（默认关；偏好持久化） */
  const [ttsEnabled, setTtsEnabled] = useState(() => localStorage.getItem(CHAT_TTS_KEY) === '1');
  /** 正在朗读的消息 id（用于"再点停止"与高亮复位） */
  const [speakingMsgId, setSpeakingMsgId] = useState<number | null>(null);
  /** 当前是否在播放中（队列调度用，避免 onend/onerror 竞态重入） */
  const speakingRef = useRef(false);
  /** 当前 utterance 令牌：onend/onerror 只认自己这条（cancel 后旧回调不清新状态） */
  const currentUtterRef = useRef<SpeechSynthesisUtterance | null>(null);
  /** 已朗读过的消息 id：防止打开开关瞬间补读开关前的最后一条实时消息 */
  const lastReadMsgIdRef = useRef<number | null>(null);
  /**
   * 「下一个宏任务再 speak」的定时器。原实现丢弃了 id：stopTTS（退出房间/卸载）
   * 之后这个待触发的回调仍可能跑一次 speechSynthesis.speak —— 浏览器若在清理
   * 之前先跑了宏任务，用户会听到已经离开的房间里的消息。
   */
  const speakDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 可用语音缓存（getVoices 异步就绪，voiceschanged 事件刷新） */
  const voicesRef = useRef<{ zh: SpeechSynthesisVoice | null; en: SpeechSynthesisVoice | null }>({
    zh: null,
    en: null,
  });

  /** 停止朗读（打断当前 + 清状态；令牌置空使旧 utterance 的迟到回调失效） */
  const stopTTS = useCallback(() => {
    if (!ttsSupported) return;
    // 取消尚未触发的延迟播放（否则退出房间后仍可能出声一次）
    if (speakDelayRef.current !== null) {
      clearTimeout(speakDelayRef.current);
      speakDelayRef.current = null;
    }
    window.speechSynthesis.cancel();
    speakingRef.current = false;
    currentUtterRef.current = null;
    setSpeakingMsgId(null);
  }, [ttsSupported]);

  /** 朗读一条消息：新消息打断正在播的旧消息（最新优先），播完自动复位 */
  const speakMessage = useCallback(
    (id: number, text: string, lang: 'zh' | 'en') => {
      if (!ttsSupported) return;
      const synth = window.speechSynthesis;
      // 先打断正在播的（若正在播同一条则是"再点停止"语义，由调用方处理）
      synth.cancel();
      speakingRef.current = true; // P2 修复：立即置位（原实现从未置 true，防重入守卫失效）
      setSpeakingMsgId(id);
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = lang === 'zh' ? 'zh-CN' : 'en-US';
      const voice = lang === 'zh' ? voicesRef.current.zh : voicesRef.current.en;
      if (voice) utter.voice = voice;
      const finish = () => {
        // P2 修复：令牌守卫——只有仍是最新一条时才复位（cancel 会触发旧 utterance
        // 的 onend，若不加守卫会把新消息的高亮/状态清掉）
        if (currentUtterRef.current !== utter) return;
        currentUtterRef.current = null;
        speakingRef.current = false;
        setSpeakingMsgId(null);
      };
      utter.onend = finish;
      utter.onerror = finish;
      currentUtterRef.current = utter;
      // Chrome 在 cancel 后立即 speak 可能静默失败（crbug 已知问题），
      // 延迟到下一个宏任务再播，避开 cancel 的内部异步清理窗口
      if (speakDelayRef.current !== null) clearTimeout(speakDelayRef.current);
      speakDelayRef.current = setTimeout(() => {
        speakDelayRef.current = null;
        // 期间被更新的消息打断（令牌已换）则不播这条
        if (currentUtterRef.current === utter) synth.speak(utter);
      }, 0);
    },
    [ttsSupported]
  );

  /** 点击消息手动朗读（自己的消息也可读）；再点正在朗读的同一消息 → 停止 */
  const handleSpeakMessage = useCallback(
    (m: VoiceChatMessage) => {
      if (!ttsSupported) {
        showToast('当前浏览器不支持朗读');
        return;
      }
      if (speakingMsgId === m.id) {
        stopTTS();
        return;
      }
      // 语言只按消息内容判定（666 → 中文"六六六"；英文内容 → 英文语音）
      speakMessage(m.id, `${m.username}说${m.content}`, detectSpeakLang(m.content));
    },
    [ttsSupported, speakingMsgId, stopTTS, speakMessage]
  );

  /** 朗读开关：开=自动朗读新消息，关=立即停止并清队列 */
  const toggleTTS = useCallback(() => {
    setTtsEnabled((prev) => {
      const next = !prev;
      localStorage.setItem(CHAT_TTS_KEY, next ? '1' : '0');
      if (next) {
        // 打开瞬间：把开关前最后一条实时消息标记为已读，避免补读旧消息
        lastReadMsgIdRef.current = liveMessage?.id ?? null;
      } else {
        stopTTS();
      }
      return next;
    });
  }, [liveMessage, stopTTS]);

  // 语音包列表异步加载（Chrome 首次 getVoices 可能为空，监听 voiceschanged）
  useEffect(() => {
    if (!ttsSupported) return;
    const loadVoices = () => {
      const voices = window.speechSynthesis.getVoices();
      voicesRef.current = {
        zh: voices.find((v) => v.lang.toLowerCase().startsWith('zh')) ?? null,
        en: voices.find((v) => v.lang.toLowerCase().startsWith('en')) ?? null,
      };
    };
    loadVoices();
    window.speechSynthesis.addEventListener('voiceschanged', loadVoices);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', loadVoices);
  }, [ttsSupported]);

  // 自动朗读：开关开启 + 有新实时消息 + 非自己发的 → 播报「用户名说内容」
  useEffect(() => {
    if (!ttsEnabled || !liveMessage) return;
    const m = liveMessage;
    if (m.id === lastReadMsgIdRef.current) return;
    lastReadMsgIdRef.current = m.id;
    // 自己的消息不自动朗读（避免与麦克风回声串扰；手动点击仍可朗读）
    const self = participants[0];
    if (self && m.sender_id === self.userId) return;
    // 异步派发朗读（speakMessage 内部会 setState 高亮，避免在 effect 内同步触发级联渲染）
    queueMicrotask(() => speakMessage(m.id, `${m.username}说${m.content}`, detectSpeakLang(m.content)));
  }, [ttsEnabled, liveMessage, participants, speakMessage]);

  // 退出房间 / 组件卸载：立即停止朗读
  useEffect(() => {
    if (!inRoom) queueMicrotask(stopTTS);
    return () => stopTTS();
  }, [inRoom, stopTTS]);

  // 页面切到后台：停止朗读（避免标签页不可见时还在出声）
  useEffect(() => {
    if (!ttsSupported) return;
    const onVisibility = () => {
      if (document.hidden) queueMicrotask(stopTTS);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [ttsSupported, stopTTS]);

  return {
    ttsSupported,
    ttsEnabled,
    speakingMsgId,
    toggleTTS,
    handleSpeakMessage,
  };
}
