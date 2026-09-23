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

/**
 * 语音合成对象的形态（标准 SpeechSynthesis 接口）。
 * 字段声明为可选：运行时由 getTtsSynth 逐个校验，缺任一项就判为不可用。
 */
interface TtsSynth {
  speak: (utterance: SpeechSynthesisUtterance) => void;
  cancel: () => void;
  getVoices?: () => SpeechSynthesisVoice[];
  addEventListener?: (type: string, listener: EventListener) => void;
  removeEventListener?: (type: string, listener: EventListener) => void;
}

/**
 * 取可用的语音合成对象；**接口不完整就返回 null（判为不支持）**。
 *
 * ★ 判据是「要调的方法确实可调用」，而不是「属性存在」—— 但**不再做逐层降级**。
 *
 * 背景（2026-09-19 线上事故）：微信 iOS 内置 WebView 里 `window.speechSynthesis`
 * **存在但是残缺对象** —— 没有 `addEventListener` / `removeEventListener`
 * （SpeechSynthesis 本应继承 EventTarget），部分版本连 `getVoices` 都没有。
 * 旧实现用 `'speechSynthesis' in window` 判支持 → true → 挂载后第一个 effect 调
 * `addEventListener('voiceschanged')` → TypeError → 被错误边界接住 →
 * **整个语音页变成「页面出错了」**。
 *
 * 2026-09-19 决策：这类"缺胳膊少腿"的内核**不再走兼容分支**（早先试过退回
 * `onvoiceschanged` 属性赋值），而是直接判为不支持 → 朗读开关置灰。
 * 宁可明确少一个功能，也不要一个会随机崩掉整页的功能。
 */
function getTtsSynth(): TtsSynth | null {
  if (typeof window === 'undefined') return null;
  const synth = (window as unknown as { speechSynthesis?: Partial<TtsSynth> }).speechSynthesis;
  if (!synth) return null;
  const required = ['speak', 'cancel', 'getVoices', 'addEventListener', 'removeEventListener'] as const;
  for (const key of required) {
    if (typeof synth[key] !== 'function') return null;
  }
  return synth as TtsSynth;
}

/**
 * 朗读总能力：合成对象可用 **且** 能构造 utterance。
 * `SpeechSynthesisUtterance` 同样可能缺失（残缺内核），而它是在 speak 时才被 new 的
 * —— 放在这里一起判，才能把"不支持的设备"挡在开关置灰那一步，而不是点击后才炸。
 */
function detectTtsSupported(): boolean {
  return getTtsSynth() !== null && typeof SpeechSynthesisUtterance === 'function';
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
  /** 浏览器是否支持语音合成（不支持时开关置灰）—— 功能性检测，见 detectTtsSupported */
  const ttsSupported = detectTtsSupported();
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
    // 取消尚未触发的延迟播放（否则退出房间后仍可能出声一次）
    if (speakDelayRef.current !== null) {
      clearTimeout(speakDelayRef.current);
      speakDelayRef.current = null;
    }
    // 每次现取：能力探测不缓存，取不到就跳过（不支持朗读的设备上这里是 no-op，
    // 但上面的定时器清理必须照做）
    getTtsSynth()?.cancel();
    speakingRef.current = false;
    currentUtterRef.current = null;
    setSpeakingMsgId(null);
  }, []);

  /** 朗读一条消息：新消息打断正在播的旧消息（最新优先），播完自动复位 */
  const speakMessage = useCallback((id: number, text: string, lang: 'zh' | 'en') => {
    const synth = getTtsSynth();
    // 缺少合成对象或构造器时静默返回，而不是抛错（本函数会被事件处理器与
    // 自动朗读 effect 调用，抛出即整页崩）
    if (!synth || typeof SpeechSynthesisUtterance !== 'function') return;
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
  }, []);

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

  // 语音包列表异步加载（Chrome 首次 getVoices 可能为空，靠 voiceschanged 刷新）
  //
  // ★ 这个 effect 是 2026-09-19 语音页整页崩溃的现场：残缺内核没有 addEventListener，
  //   直接调就 TypeError，而 effect 里抛出的异常会被错误边界接住 → 整页变兜底 UI。
  //   现在 getTtsSynth 已经把"接口不完整"的内核整体判为不支持（开关置灰），
  //   所以走到这里的对象一定是标准完整的 —— 不再需要任何逐层回退分支。
  useEffect(() => {
    const synth = getTtsSynth();
    if (!synth) return;
    const loadVoices = () => {
      const voices = synth.getVoices?.() ?? [];
      // voice.lang 仍可能缺失（音色对象残缺属于数据问题，不是接口问题）
      const pick = (prefix: string) =>
        voices.find((v) =>
          String(v?.lang ?? '')
            .toLowerCase()
            .startsWith(prefix)
        ) ?? null;
      voicesRef.current = { zh: pick('zh'), en: pick('en') };
    };
    loadVoices();
    synth.addEventListener?.('voiceschanged', loadVoices);
    return () => synth.removeEventListener?.('voiceschanged', loadVoices);
  }, []);

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
    const onVisibility = () => {
      if (document.hidden) queueMicrotask(stopTTS);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [stopTTS]);

  return {
    ttsSupported,
    ttsEnabled,
    speakingMsgId,
    toggleTTS,
    handleSpeakMessage,
  };
}
