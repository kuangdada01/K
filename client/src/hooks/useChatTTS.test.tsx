/**
 * ============================================================
 * 聊天朗读 Hook 单测（hooks/useChatTTS.test）
 * ============================================================
 * 重点覆盖 §3.2 两处 P2 修复：
 * 1. speakingRef 立即置位 → 新朗读打断旧的派发（旧 utterance 不再 speak）
 * 2. cancel 触发旧 utterance onend 时带令牌守卫 → 不清掉新消息的
 *    speakingMsgId/朗读状态
 * 以及既有不变量：开关持久化、再点同一条=停止、自动朗读格式
 * 「用户名说内容」、自己的消息不自动朗读、打开开关不补读最后一条。
 *
 * 2026-09-27 追加「云端音色」用例：选音色持久化、走 /api/tts（前端只发音色 key）、
 * 长文分段、播完复位、失败不崩、残缺内核下切云端仍可朗读。
 * ============================================================
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useChatTTS, detectSpeakLang, splitSpeakText } from './useChatTTS';
import { TTS_SYSTEM_VOICE_KEY } from '@k/shared';
import type { VoiceChatMessage, VoiceParticipant } from '../types';

class FakeSynth {
  cancel = vi.fn();
  speak = vi.fn();
  getVoices = vi.fn(() => []);
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
}

class FakeUtterance {
  lang = '';
  voice: SpeechSynthesisVoice | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}

const msg = (id: number, senderId: number, content: string): VoiceChatMessage => ({
  id,
  room_id: 1,
  sender_id: senderId,
  username: `u${senderId}`,
  avatar: null,
  content,
  created_at: new Date().toISOString(),
});

const self: VoiceParticipant = {
  userId: 1,
  username: 'me',
  avatar: null,
  muted: false,
  listener: false,
  sharing: false,
};

/**
 * 全文件共用的桩：系统语音（speechSynthesis + utterance + 假定时器）。
 * 放在顶层 beforeEach —— 「云端音色」用例同样要在真实浏览器语义下跑
 * （云端的假音频在各自的 describe 里另加桩）。
 *
 * 注意：afterEach 里**不能** `vi.unstubAllGlobals()` —— afterEach 倒序执行，
 * setup.ts 的 cleanup()（组件卸载 → stopTTS 访问 window.speechSynthesis）在它之后
 * 运行，先还原会导致卸载期崩溃。beforeEach 会重新 stub，无需显式还原。
 */
let synth: FakeSynth;
let utterances: FakeUtterance[];

beforeEach(() => {
  synth = new FakeSynth();
  utterances = [];
  vi.stubGlobal('speechSynthesis', synth);
  vi.stubGlobal(
    'SpeechSynthesisUtterance',
    class extends FakeUtterance {
      constructor(text: string) {
        super(text);
        utterances.push(this);
      }
    }
  );
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useChatTTS', () => {
  function setup(initial: {
    liveMessage: VoiceChatMessage | null;
    participants: VoiceParticipant[];
    inRoom: boolean;
  }) {
    // 经 initialProps 传入：rerender 才能携带新状态（闭包传参会一直读到旧值）
    return renderHook(({ state }) => useChatTTS(state), { initialProps: { state: initial } });
  }

  function rerenderState(
    h: ReturnType<typeof setup>,
    next: { liveMessage: VoiceChatMessage | null; participants: VoiceParticipant[]; inRoom: boolean }
  ) {
    act(() => h.rerender({ state: next }));
  }

  function speakCurrent() {
    act(() => {
      vi.advanceTimersByTime(0); // 触发延迟 speak
    });
    return utterances[utterances.length - 1]!;
  }

  it('语言判定：中文→zh、纯英文→en、数字/符号→zh', () => {
    expect(detectSpeakLang('你好')).toBe('zh');
    expect(detectSpeakLang('hello world')).toBe('en');
    expect(detectSpeakLang('666')).toBe('zh');
    expect(detectSpeakLang('😀')).toBe('zh');
  });

  it('朗读：cancel 后延迟 speak（宏任务），speakingMsgId 置位', () => {
    const h = setup({ liveMessage: null, participants: [self], inRoom: true });
    act(() => h.result.current.handleSpeakMessage(msg(1, 2, 'hi')));
    expect(synth.cancel).toHaveBeenCalledTimes(1);
    expect(h.result.current.speakingMsgId).toBe(1);
    expect(synth.speak).not.toHaveBeenCalled(); // 宏任务未到
    speakCurrent();
    expect(synth.speak).toHaveBeenCalledTimes(1);
    expect(utterances[0]!.text).toBe('u2说hi');
    // 播完复位
    act(() => utterances[0]!.onend?.());
    expect(h.result.current.speakingMsgId).toBeNull();
  });

  it('P2 修复 1：新朗读打断旧朗读的派发——旧 utterance 不再 speak（speakingRef 立即置位）', () => {
    const h = setup({ liveMessage: null, participants: [self], inRoom: true });
    act(() => h.result.current.handleSpeakMessage(msg(1, 2, 'first')));
    act(() => h.result.current.handleSpeakMessage(msg(2, 3, 'second')));
    expect(h.result.current.speakingMsgId).toBe(2);
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(synth.speak).toHaveBeenCalledTimes(1); // 只有第二条被播出
    const spoken = synth.speak.mock.calls[0]![0] as FakeUtterance;
    expect(spoken.text).toBe('u3说second');
  });

  it('P2 修复 2：cancel 触发旧 utterance onend，不清掉新消息的高亮与状态（令牌守卫）', () => {
    const h = setup({ liveMessage: null, participants: [self], inRoom: true });
    act(() => h.result.current.handleSpeakMessage(msg(1, 2, 'first')));
    const first = speakCurrent(); // 第一条已在播
    // 播第二条：synth.cancel() 会异步触发 first.onend（真实浏览器行为）
    act(() => h.result.current.handleSpeakMessage(msg(2, 3, 'second')));
    act(() => first.onend?.()); // cancel 后旧 utterance 的迟到回调
    expect(h.result.current.speakingMsgId).toBe(2); // 不被旧回调清掉
    speakCurrent();
    expect(synth.speak).toHaveBeenCalledTimes(2);
    // 第二条自己播完才复位
    act(() => utterances[1]!.onend?.());
    expect(h.result.current.speakingMsgId).toBeNull();
  });

  it('再点正在朗读的同一消息 → 停止；stopTTS 后旧回调不再改状态', () => {
    const h = setup({ liveMessage: null, participants: [self], inRoom: true });
    act(() => h.result.current.handleSpeakMessage(msg(1, 2, 'hi')));
    const first = speakCurrent();
    act(() => h.result.current.handleSpeakMessage(msg(1, 2, 'hi'))); // 再点同一条
    expect(synth.cancel).toHaveBeenCalled();
    expect(h.result.current.speakingMsgId).toBeNull();
    act(() => first.onend?.()); // 停止后旧回调不应复活状态
    expect(h.result.current.speakingMsgId).toBeNull();
  });

  it('自动朗读：开关开启 + 新消息（非自己）→ 播报「用户名说内容」；自己的消息不自动朗读', async () => {
    const liveMessage = msg(10, 2, 'hello');
    const h = setup({ liveMessage, participants: [self], inRoom: true });
    expect(h.result.current.ttsEnabled).toBe(false);
    act(() => h.result.current.toggleTTS());
    expect(h.result.current.ttsEnabled).toBe(true);
    expect(localStorage.getItem('voice:chatTTS')).toBe('1');
    // liveMessage 已是最新（开关前最后一条）：不补读
    speakCurrent();
    expect(synth.speak).not.toHaveBeenCalled();

    // 新消息（别人发的）→ 自动朗读（自动朗读走 queueMicrotask，需先 flush 微任务）
    rerenderState(h, { liveMessage: msg(11, 3, 'world'), participants: [self], inRoom: true });
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(synth.speak).toHaveBeenCalledTimes(1);
    expect((synth.speak.mock.calls[0]![0] as FakeUtterance).text).toBe('u3说world');

    // 自己的消息 → 不自动朗读
    rerenderState(h, { liveMessage: msg(12, 1, 'mine'), participants: [self], inRoom: true });
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(synth.speak).toHaveBeenCalledTimes(1);
  });

  it('关闭开关：停止并清空；退出房间：立即停止', async () => {
    const h = setup({ liveMessage: msg(1, 2, 'hi'), participants: [self], inRoom: true });
    act(() => h.result.current.toggleTTS());
    rerenderState(h, { liveMessage: msg(2, 3, 'there'), participants: [self], inRoom: true });
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(synth.speak).toHaveBeenCalledTimes(1);

    act(() => h.result.current.toggleTTS()); // 关闭
    expect(synth.cancel).toHaveBeenCalled();
    expect(h.result.current.speakingMsgId).toBeNull();
    expect(localStorage.getItem('voice:chatTTS')).toBe('0');

    act(() => rerenderState(h, { liveMessage: null, participants: [self], inRoom: false }));
    act(() => h.result.current.handleSpeakMessage(msg(3, 2, 'again')));
    expect(h.result.current.speakingMsgId).toBe(3); // 手动朗读不受开关限制
  });

  it('不支持 speechSynthesis：开关置灰且朗读为 no-op', () => {
    // 删除属性模拟浏览器不支持（stubGlobal(undefined) 仍使 `in window` 为 true）
    const desc = Object.getOwnPropertyDescriptor(window, 'speechSynthesis');
    // @ts-expect-error 删除以模拟浏览器不支持
    delete window.speechSynthesis;
    try {
      const h = setup({ liveMessage: null, participants: [self], inRoom: true });
      expect(h.result.current.ttsSupported).toBe(false);
      act(() => h.result.current.handleSpeakMessage(msg(1, 2, 'hi')));
      expect(h.result.current.speakingMsgId).toBeNull();
    } finally {
      if (desc) Object.defineProperty(window, 'speechSynthesis', desc);
    }
  });

  /**
   * ★ 2026-09-19 线上事故回归用例：
   * 微信 iOS 内置 WebView 的 speechSynthesis **存在但是残缺对象** ——
   * speak/cancel 在，但没继承 EventTarget（没有 addEventListener）。
   * 旧实现用 `'speechSynthesis' in window` 判支持 → 判为 true → 挂载后第一个
   * effect 调 addEventListener 即 TypeError → 错误边界接住 → 整个语音页变
   * 「页面出错了」。
   *
   * 现按"不再兼容过低版本"的决策：这类内核**直接判为不支持**（开关置灰），
   * 不再走 onvoiceschanged 之类的回退；关键断言是**挂载不抛错**。
   */
  it('speechSynthesis 残缺（无 addEventListener / getVoices）：判为不支持，挂载不抛错', () => {
    vi.stubGlobal('speechSynthesis', { speak: synth.speak, cancel: synth.cancel });

    const h = setup({ liveMessage: null, participants: [self], inRoom: true });

    expect(h.result.current.ttsSupported).toBe(false);
    act(() => h.result.current.handleSpeakMessage(msg(1, 2, 'hi')));
    expect(h.result.current.speakingMsgId).toBeNull();
    expect(synth.speak).not.toHaveBeenCalled();
  });

  it('speechSynthesis 只有空壳（speak/cancel 缺失）：判为不支持，调用为 no-op', () => {
    vi.stubGlobal('speechSynthesis', {});

    const h = setup({ liveMessage: null, participants: [self], inRoom: true });

    expect(h.result.current.ttsSupported).toBe(false);
    act(() => h.result.current.handleSpeakMessage(msg(1, 2, 'hi')));
    expect(h.result.current.speakingMsgId).toBeNull();
    expect(synth.speak).not.toHaveBeenCalled();
  });

  it('SpeechSynthesisUtterance 构造器缺失：判为不支持，不抛错', () => {
    vi.stubGlobal('SpeechSynthesisUtterance', undefined);

    const h = setup({ liveMessage: null, participants: [self], inRoom: true });

    expect(h.result.current.ttsSupported).toBe(false);
    act(() => h.result.current.handleSpeakMessage(msg(1, 2, 'hi')));
    expect(h.result.current.speakingMsgId).toBeNull();
  });
});

/**
 * ============================================================
 * 云端音色（2026-09-27 接入 StepFun StepAudio 2.5 TTS）
 * ============================================================
 * 关键约定：前端只发**音色 key**（共享包里的 `dengziqi`），
 * 请求发往同源 `/api/tts`，API Key 与厂商音色 ID 都在服务端。
 * ============================================================
 */
describe('useChatTTS 云端音色', () => {
  /** 假音频元素：jsdom 的 HTMLMediaElement.play() 未实现，且 onended 需要我们手动触发 */
  class FakeAudio {
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    pause = vi.fn();
    play = vi.fn(() => Promise.resolve());
    constructor(public src: string) {
      audios.push(this);
    }
  }

  let audios: FakeAudio[];
  let fetchMock: ReturnType<typeof vi.fn>;
  /** 让 fetch/Blob/分段播放的微任务链跑完（全链路都是 Promise，无需推进假定时器） */
  const flush = () =>
    act(async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });

  beforeEach(() => {
    audios = [];
    vi.stubGlobal('Audio', FakeAudio);
    // jsdom 没有 createObjectURL（真实浏览器有）：给个可控桩，便于断言回收
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn((b: Blob) => `blob:fake-${(b as unknown as { n?: number }).n ?? audios.length}`),
      configurable: true,
      writable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true, writable: true });
    fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { text: string; voice: string };
      return {
        ok: true,
        status: 200,
        blob: async () => new Blob([body.text]),
      };
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  function setupCloud() {
    return renderHook(() => useChatTTS({ liveMessage: null, participants: [self], inRoom: true }));
  }

  it('splitSpeakText：短句合并成一段、超长按上限切段、空串返回空', () => {
    // 短句不逐句请求（省额度也少一次 RTT）：合并到一段里
    expect(splitSpeakText('你好。世界！')).toEqual(['你好。世界！']);
    expect(splitSpeakText('')).toEqual([]);
    expect(splitSpeakText('   ')).toEqual([]);
    // 超长时按句切开（每段不超 900），拼回来与原文一致
    const sentences = `${'甲'.repeat(600)}。${'乙'.repeat(600)}。`;
    expect(splitSpeakText(sentences)).toEqual([`${'甲'.repeat(600)}。`, `${'乙'.repeat(600)}。`]);
    // 整段无标点的长文：硬切成多段，且每段都不超服务端上限（1000）
    const long = '甲'.repeat(2500);
    const chunks = splitSpeakText(long);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 1000)).toBe(true);
    expect(chunks.join('')).toBe(long);
  });

  it('默认音色是系统语音（不改变老用户行为），可切到云端并持久化', () => {
    const h = setupCloud();
    expect(h.result.current.voiceKey).toBe(TTS_SYSTEM_VOICE_KEY);
    act(() => h.result.current.setVoiceKey('dengziqi'));
    expect(h.result.current.voiceKey).toBe('dengziqi');
    expect(localStorage.getItem('voice:chatTTSVoice')).toBe('dengziqi');
    // 非法 key 一律忽略（防脏数据把朗读打哑）
    act(() => h.result.current.setVoiceKey('nope'));
    expect(h.result.current.voiceKey).toBe('dengziqi');
  });

  it('云端朗读：请求同源 /api/tts，只发音色 key；播完复位高亮', async () => {
    const h = setupCloud();
    act(() => h.result.current.setVoiceKey('dengziqi'));
    act(() => h.result.current.handleSpeakMessage(msg(7, 2, '你好')));
    expect(h.result.current.speakingMsgId).toBe(7); // 同步置位（先高亮，再等音频）
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/tts');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toEqual({ text: 'u2说你好', voice: 'dengziqi' });
    // 请求体里绝不能出现任何密钥字段
    expect(JSON.stringify(body)).not.toMatch(/key|token/i);
    expect(audios).toHaveLength(1);

    act(() => audios[0]!.onended?.());
    await flush();
    expect(h.result.current.speakingMsgId).toBeNull();
  });

  it('云端长文：分段请求并按序播放（段间不重叠）', async () => {
    const h = setupCloud();
    act(() => h.result.current.setVoiceKey('dengziqi'));
    const long = `${'甲'.repeat(600)}。${'乙'.repeat(600)}。`;
    act(() => h.result.current.handleSpeakMessage(msg(8, 2, long)));
    await flush();

    // 两段请求（第二段是预取命中的同一 Promise，不会重复请求）
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(audios).toHaveLength(1); // 第一段还在播，第二段尚未开始
    const texts = fetchMock.mock.calls.map(
      (c) => (JSON.parse(String((c[1] as RequestInit).body)) as { text: string }).text
    );
    expect(texts.every((t) => t.length <= 1000)).toBe(true);

    act(() => audios[0]!.onended?.());
    await flush();
    expect(audios).toHaveLength(2); // 第一段播完才播第二段
    act(() => audios[1]!.onended?.());
    await flush();
    expect(h.result.current.speakingMsgId).toBeNull();
  });

  it('云端失败：提示并复位，不崩；停止后迟到的响应不改状态', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({ error: '云端朗读未配置（服务端缺少 STEP_API_KEY）' }),
    });
    const h = setupCloud();
    act(() => h.result.current.setVoiceKey('dengziqi'));
    act(() => h.result.current.handleSpeakMessage(msg(9, 2, 'hi')));
    await flush();
    expect(h.result.current.speakingMsgId).toBeNull();
    expect(audios).toHaveLength(0);

    // 迟到的分段：停止后再 resolve 也不得复活高亮
    let release: ((v: unknown) => void) | null = null;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((res) => {
          release = res as (v: unknown) => void;
        })
    );
    act(() => h.result.current.handleSpeakMessage(msg(10, 2, 'again')));
    expect(h.result.current.speakingMsgId).toBe(10);
    act(() => h.result.current.handleSpeakMessage(msg(10, 2, 'again'))); // 再点 = 停止
    expect(h.result.current.speakingMsgId).toBeNull();
    await act(async () => {
      release?.({ ok: true, status: 200, blob: async () => new Blob(['x']) });
      for (let i = 0; i < 4; i++) await Promise.resolve();
    });
    expect(h.result.current.speakingMsgId).toBeNull();
    expect(audios).toHaveLength(0);
  });

  it('残缺内核（speechSynthesis 判不支持）下切到云端音色仍能朗读', () => {
    vi.stubGlobal('speechSynthesis', {}); // 微信 iOS WebView 那类残缺对象
    const h = setupCloud();
    expect(h.result.current.systemTtsSupported).toBe(false);
    expect(h.result.current.ttsSupported).toBe(false); // 系统语音：开关置灰

    act(() => h.result.current.setVoiceKey('dengziqi'));
    expect(h.result.current.ttsSupported).toBe(true); // 云端音色不受内核算力限制
    act(() => h.result.current.handleSpeakMessage(msg(11, 2, 'hi')));
    expect(h.result.current.speakingMsgId).toBe(11);
  });

  it('换音色会打断正在朗读的消息', () => {
    const h = setupCloud();
    act(() => h.result.current.handleSpeakMessage(msg(12, 2, 'hi'))); // 系统语音路径
    const utter = utterances[utterances.length - 1]!;
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(synth.speak).toHaveBeenCalledTimes(1);

    act(() => h.result.current.setVoiceKey('dengziqi'));
    expect(h.result.current.speakingMsgId).toBeNull();
    act(() => utter.onend?.()); // 旧 utterance 的迟到回调不得复活状态
    expect(h.result.current.speakingMsgId).toBeNull();
  });
});
