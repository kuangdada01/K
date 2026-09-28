/**
 * ============================================================
 * 语音聊天朗读 Hook（hooks/useChatTTS）
 * ============================================================
 * 自 VoicePage.tsx 拆出（§3.2）。两种音色通道，由下拉框选择（偏好持久化）：
 *
 * 1. **system**（默认）—— 浏览器自带 `speechSynthesis`，零成本、无需联网；
 * 2. **cloud** —— 服务端代理 `/api/tts`（StepFun StepAudio 2.5 TTS），
 *    音色为已复刻的「邓紫棋」。**API Key 只在服务端**：前端只发共享包里的
 *    音色 key（`dengziqi`），浏览器抓包也拿不到密钥、厂商、音色 ID。
 *
 * 历史修复（行为不变量，勿改）：
 * 1. 派发朗读时立即置位 speakingRef + 会话令牌，防重入与"点开关瞬间补读"竞态。
 * 2. cancel 之后旧 utterance/旧音频的迟到回调**不得**清掉新消息的高亮与状态
 *    —— 统一由会话令牌（sessionRef）守卫，只认自己这一条。
 *
 * 其余不变量：朗读开关持久化键、语言判定（内容含中文→zh、纯英文→en、数字→zh）、
 * 「用户名说内容」播报格式、自己的消息不自动朗读、页面切后台停止、退房/卸载停止、
 * 新消息打断旧消息（最新优先）、再点同一消息=停止。
 *
 * ★ 2026-09-27 新增云端音色：云端通道让「朗读」在**微信 iOS WebView 这类
 *   speechSynthesis 残缺的内核**上也能用（那些内核此前只能把开关置灰）。
 * ============================================================
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { VoiceChatMessage, VoiceParticipant } from '../types';
import { showToast } from '../components/ui/Toast';
import { getApiBaseUrl } from '../config';
import { TTS_CHUNK_CHARS, TTS_CLOUD_VOICES, TTS_MAX_CHARS, TTS_SYSTEM_VOICE_KEY } from '@k/shared';

/** 朗读开关的 localStorage 键（同降噪/音乐模式的偏好持久化惯例） */
const CHAT_TTS_KEY = 'voice:chatTTS';
/** 所选音色的 localStorage 键（未设置 = 系统语音，即线上原有行为） */
const CHAT_TTS_VOICE_KEY = 'voice:chatTTSVoice';

/**
 * 判断消息内容语言（只对内容判定，不含用户名，避免英文用户名带偏检测）：
 * - 含中文 → zh（中文优先）
 * - 纯英文字母 → en
 * - 无中文也无字母（纯数字/符号/表情，如 666）→ zh（数字用中文念法："666"→"六六六"）
 *
 * 只对系统语音有意义：云端模型自己会判语言。
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
 * `onvoiceschanged` 属性赋值），而是直接判为不支持 → 系统语音置灰。
 * 2026-09-27 补充：云端音色不受此限制 —— 换到云端通道即可正常朗读。
 */
export function getTtsSynth(): TtsSynth | null {
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
export function detectTtsSupported(): boolean {
  return getTtsSynth() !== null && typeof SpeechSynthesisUtterance === 'function';
}

/**
 * 长文切分：按句切段，每段不超过 [TTS_CHUNK_CHARS]（云端接口单次上限 1000 字符）。
 *
 * ⚠️ **不要用后行断言**（`(?<=[。！？])` 这类写法）：lookbehind 要 Safari 16.4 /
 * iOS 16.4 才有，而本项目的构建目标是 Safari 14（见 vite.config.ts 的说明）。
 * 老 iOS 微信 WebView 上的表现是**解析期就失败**，整块脚本报废。
 * 这里改用 `match` 正向匹配「正文 + 随后的终止标点」，语义等价且全平台可用。
 */
export function splitSpeakText(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const parts = (normalized.match(/[^。！？!?；;.\n]+[。！？!?；;.]*/g) ?? [normalized])
    .map((s) => s.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let cur = '';
  for (const p of parts) {
    if (cur && cur.length + p.length > TTS_CHUNK_CHARS) {
      chunks.push(cur);
      cur = p;
    } else {
      cur += p;
    }
  }
  if (cur) chunks.push(cur);
  // 单句本身就超限（整段无标点的长文）：硬切，保证单次请求不超服务端上限
  return chunks.flatMap((c) =>
    c.length > TTS_MAX_CHARS
      ? Array.from({ length: Math.ceil(c.length / TTS_CHUNK_CHARS) }, (_, i) =>
          c.slice(i * TTS_CHUNK_CHARS, (i + 1) * TTS_CHUNK_CHARS)
        )
      : [c]
  );
}

/** 音色 key 是否在允许清单内（系统 + 共享包里的云端清单） */
function isKnownVoice(key: string): boolean {
  return key === TTS_SYSTEM_VOICE_KEY || TTS_CLOUD_VOICES.some((v) => v.key === key);
}

/**
 * 请求一段云端音频，返回 Blob。
 *
 * 返回 Blob 而不是 objectURL：调用方按段 create/revoke，预取但没播到的分片
 * 不会留下无法回收的 URL（预取是常态，见 playCloud）。
 */
async function fetchCloudAudio(text: string, voice: string, signal: AbortSignal): Promise<Blob> {
  const token = localStorage.getItem('k_token');
  const r = await fetch(`${getApiBaseUrl()}/tts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // 带上登录态：服务端按用户维度限流（额度更宽），游客按 IP 收紧
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ text, voice }),
    signal,
  });
  if (!r.ok) {
    // 服务端失败时回的是 JSON（{ error }）；网关层可能是 HTML，取不到就用状态码
    let msg = `朗读服务异常（${r.status}）`;
    try {
      const data = (await r.json()) as { error?: string };
      if (data?.error) msg = data.error;
    } catch {
      /* 非 JSON：保留默认文案 */
    }
    throw new Error(msg);
  }
  return r.blob();
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
  /** 系统语音是否可用（残缺内核判 false；云端音色不受影响） */
  const systemTtsSupported = detectTtsSupported();
  /** 朗读开关（默认关；偏好持久化） */
  const [ttsEnabled, setTtsEnabled] = useState(() => localStorage.getItem(CHAT_TTS_KEY) === '1');
  /** 所选音色 key（默认系统语音 = 不花钱、不改变老用户行为；偏好持久化） */
  const [voiceKey, setVoiceKeyState] = useState<string>(() => {
    const saved = localStorage.getItem(CHAT_TTS_VOICE_KEY);
    return saved && isKnownVoice(saved) ? saved : TTS_SYSTEM_VOICE_KEY;
  });
  /**
   * 当前所选音色是否可用：系统通道看内核能力（残缺内核判 false），
   * 云端通道恒可用（fetch + Audio 是所有目标内核的基线能力）。
   * 声明在回调之前：handleSpeakMessage 的依赖数组会在 render 期读取它。
   */
  const ttsSupported = voiceKey === TTS_SYSTEM_VOICE_KEY ? systemTtsSupported : true;
  /** 正在朗读的消息 id（用于"再点停止"与高亮复位） */
  const [speakingMsgId, setSpeakingMsgId] = useState<number | null>(null);
  /** 当前是否在播放中（队列调度用，避免 onend/onerror 竞态重入） */
  const speakingRef = useRef(false);
  /**
   * 朗读会话令牌：每次派发 +1。所有异步回调（utterance 的 onend/onerror、
   * 云端分段播放的每一段、fetch 的 catch）都先比对自己那一票，
   * 不是当前会话就直接返回 —— 这一条替代了原先的 utterance 实例比对，
   * 对"系统 + 云端"两条通道同样有效（cancel 会触发旧 onend 是浏览器既有行为）。
   */
  const sessionRef = useRef(0);
  /** 已朗读过的消息 id：防止打开开关瞬间补读开关前的最后一条实时消息 */
  const lastReadMsgIdRef = useRef<number | null>(null);
  /**
   * 「下一个宏任务再 speak」的定时器。原实现丢弃了 id：stopTTS（退出房间/卸载）
   * 之后这个待触发的回调仍可能跑一次 speechSynthesis.speak —— 浏览器若在清理
   * 之前先跑了宏任务，用户会听到已经离开的房间里的消息。
   */
  const speakDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 云端通道：在途请求的中止句柄（停止/打断/卸载时 abort，省流量也省额度） */
  const abortRef = useRef<AbortController | null>(null);
  /** 云端通道：当前正在播放的音频元素 */
  const audioRef = useRef<HTMLAudioElement | null>(null);
  /** 可用语音缓存（getVoices 异步就绪，voiceschanged 事件刷新） */
  const voicesRef = useRef<{ zh: SpeechSynthesisVoice | null; en: SpeechSynthesisVoice | null }>({
    zh: null,
    en: null,
  });

  /** 停止朗读（打断当前 + 清状态；会话令牌 +1 使所有在途回调/请求失效） */
  const stopTTS = useCallback(() => {
    sessionRef.current += 1;
    // 取消尚未触发的延迟播放（否则退出房间后仍可能出声一次）
    if (speakDelayRef.current !== null) {
      clearTimeout(speakDelayRef.current);
      speakDelayRef.current = null;
    }
    // 云端通道：中止在途请求 + 停掉正在播的音频
    abortRef.current?.abort();
    abortRef.current = null;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    // 每次现取：能力探测不缓存，取不到就跳过（不支持朗读的设备上这里是 no-op，
    // 但上面的定时器清理必须照做）
    getTtsSynth()?.cancel();
    speakingRef.current = false;
    setSpeakingMsgId(null);
  }, []);

  /**
   * 系统语音播放：cancel 后延迟到下一个宏任务再 speak
   * （Chrome 在 cancel 后立即 speak 可能静默失败，crbug 已知问题）。
   */
  const playSystem = useCallback((token: number, text: string, lang: 'zh' | 'en') => {
    const synth = getTtsSynth();
    if (!synth || typeof SpeechSynthesisUtterance !== 'function') return;
    synth.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = lang === 'zh' ? 'zh-CN' : 'en-US';
    const voice = lang === 'zh' ? voicesRef.current.zh : voicesRef.current.en;
    if (voice) utter.voice = voice;
    const finish = () => {
      // 令牌守卫：只有仍是最新一条时才复位（cancel 会触发旧 utterance 的 onend，
      // 若不加守卫会把新消息的高亮/状态清掉）
      if (sessionRef.current !== token) return;
      sessionRef.current += 1;
      speakingRef.current = false;
      setSpeakingMsgId(null);
    };
    utter.onend = finish;
    utter.onerror = finish;
    if (speakDelayRef.current !== null) clearTimeout(speakDelayRef.current);
    speakDelayRef.current = setTimeout(() => {
      speakDelayRef.current = null;
      // 期间被更新的消息打断（令牌已换）则不播这条
      if (sessionRef.current === token) synth.speak(utter);
    }, 0);
  }, []);

  /**
   * 云端音色播放：长文按 [splitSpeakText] 分段，边下边播（预取后两段）。
   *
   * 首段要等 2~5 秒（非流式接口），所以预取是必需的 —— 否则段与段之间会明显卡顿。
   * 任何一段失败都终止本次朗读并提示；被停止/打断时静默退出（不打扰用户）。
   */
  const playCloud = useCallback(async (token: number, text: string, voice: string) => {
    const chunks = splitSpeakText(text);
    if (!chunks.length) return;
    const controller = new AbortController();
    abortRef.current = controller;
    /** 分段结果缓存：同一段只请求一次（预取与播放共用同一个 Promise） */
    const cache = new Map<number, Promise<Blob>>();
    const getChunk = (i: number): Promise<Blob> => {
      let p = cache.get(i);
      if (!p) {
        p = fetchCloudAudio(chunks[i]!, voice, controller.signal);
        cache.set(i, p);
      }
      return p;
    };
    try {
      for (let i = 0; i < chunks.length; i++) {
        if (sessionRef.current !== token) return;
        for (let k = i + 1; k <= Math.min(i + 2, chunks.length - 1); k++) {
          // 预取失败不在这里报错（轮到它播时才报），但必须吞掉 rejection 免得变成未处理拒绝
          void getChunk(k).catch(() => {});
        }
        const blob = await getChunk(i);
        if (sessionRef.current !== token) return;
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audioRef.current = audio;
        try {
          await new Promise<void>((resolve, reject) => {
            audio.onended = () => resolve();
            audio.onerror = () => reject(new Error('音频播放失败'));
            audio.play().catch(reject);
          });
        } finally {
          URL.revokeObjectURL(url);
          if (audioRef.current === audio) audioRef.current = null;
        }
      }
    } catch (e) {
      // 被停止/打断（AbortError）是预期路径，不提示
      const aborted = e instanceof DOMException && e.name === 'AbortError';
      if (!aborted && sessionRef.current === token) {
        showToast(e instanceof Error ? e.message : '朗读失败');
      }
    } finally {
      if (sessionRef.current === token) {
        sessionRef.current += 1;
        abortRef.current = null;
        speakingRef.current = false;
        setSpeakingMsgId(null);
      }
    }
  }, []);

  /** 派发朗读（打断旧的 → 立即置位高亮 → 按所选音色走对应通道） */
  const startSpeak = useCallback(
    (id: number, text: string, lang: 'zh' | 'en', voice: string) => {
      // 打断当前：清延迟 speak、停音频、作废在途请求（但不重复调 synth.cancel，
      // 系统通道的 cancel 由 playSystem 负责，避免同一次派发取消两次）
      if (speakDelayRef.current !== null) {
        clearTimeout(speakDelayRef.current);
        speakDelayRef.current = null;
      }
      abortRef.current?.abort();
      abortRef.current = null;
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      const token = ++sessionRef.current;
      speakingRef.current = true;
      setSpeakingMsgId(id);
      if (voice === TTS_SYSTEM_VOICE_KEY) {
        playSystem(token, text, lang);
      } else {
        // 从系统语音切到云端时，正在播的系统语音要显式停掉
        getTtsSynth()?.cancel();
        void playCloud(token, text, voice);
      }
    },
    [playSystem, playCloud]
  );

  /** 点击消息手动朗读（自己的消息也可读）；再点正在朗读的同一消息 → 停止 */
  const handleSpeakMessage = useCallback(
    (m: VoiceChatMessage) => {
      if (!ttsSupported) {
        showToast(
          voiceKey === TTS_SYSTEM_VOICE_KEY
            ? '当前浏览器不支持朗读，可把音色切换为云端音色'
            : '当前设备不支持朗读'
        );
        return;
      }
      if (speakingMsgId === m.id) {
        stopTTS();
        return;
      }
      // 语言只按消息内容判定（666 → 中文"六六六"；英文内容 → 英文语音）；云端忽略它
      startSpeak(m.id, `${m.username}说${m.content}`, detectSpeakLang(m.content), voiceKey);
    },
    [ttsSupported, voiceKey, speakingMsgId, stopTTS, startSpeak]
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

  /** 换音色：立即打断当前朗读（避免一句话里换声），并持久化选择 */
  const setVoiceKey = useCallback(
    (key: string) => {
      if (!isKnownVoice(key)) return;
      stopTTS();
      setVoiceKeyState(key);
      localStorage.setItem(CHAT_TTS_VOICE_KEY, key);
    },
    [stopTTS]
  );

  // 语音包列表异步加载（Chrome 首次 getVoices 可能为空，靠 voiceschanged 刷新）
  //
  // ★ 这个 effect 是 2026-09-19 语音页整页崩溃的现场：残缺内核没有 addEventListener，
  //   直接调就 TypeError，而 effect 里抛出的异常会被错误边界接住 → 整页变兜底 UI。
  //   现在 getTtsSynth 已经把"接口不完整"的内核整体判为不支持（系统语音置灰），
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
  // （voiceKey 在依赖里：换音色会让本 effect 重跑一次，但下面的 lastReadMsgIdRef
  //   守卫保证同一条消息不会被念第二遍）
  useEffect(() => {
    if (!ttsEnabled || !liveMessage) return;
    const m = liveMessage;
    if (m.id === lastReadMsgIdRef.current) return;
    lastReadMsgIdRef.current = m.id;
    // 自己的消息不自动朗读（避免与麦克风回声串扰；手动点击仍可朗读）
    const self = participants[0];
    if (self && m.sender_id === self.userId) return;
    // 异步派发朗读（startSpeak 内部会 setState 高亮，避免在 effect 内同步触发级联渲染）
    queueMicrotask(() =>
      startSpeak(m.id, `${m.username}说${m.content}`, detectSpeakLang(m.content), voiceKey)
    );
  }, [ttsEnabled, liveMessage, participants, startSpeak, voiceKey]);

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
    /** 系统语音是否可用（UI 据此把"系统语音"选项标灰，但不影响云端音色的选择） */
    systemTtsSupported,
    ttsEnabled,
    speakingMsgId,
    voiceKey,
    setVoiceKey,
    toggleTTS,
    handleSpeakMessage,
  };
}
