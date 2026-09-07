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
 * ============================================================
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useChatTTS, detectSpeakLang } from './useChatTTS';
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

describe('useChatTTS', () => {
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
    // 注意：不能在这里 vi.unstubAllGlobals() —— afterEach 倒序执行，setup.ts 的
    // cleanup()（组件卸载 → stopTTS 访问 window.speechSynthesis）在它之后运行，
    // 先还原会导致卸载期崩溃。beforeEach 会重新 stub，无需显式还原。
    vi.useRealTimers();
  });

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
});
