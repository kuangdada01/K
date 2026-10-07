/**
 * ============================================================
 * 语音会话生命周期单测（voice/VoiceSession.test）
 * ============================================================
 * 覆盖「加入途中会话被销毁」这一类竞态 —— teardown 只执行一次
 * （destroyed 置位后二次调用直接 return），因此 join 的续体若在
 * teardown 之后才恢复，必须自己收尾，否则会留下：
 * 1. 无人停止的麦克风轨道（系统麦克风指示灯常亮）；
 * 2. 在已 dispose 的音频图上复活的 100ms 说话检测轮询；
 * 3. 复活的 4s 质量评估轮询。
 *
 * 用真实 VoiceSession + fake AudioContext / getUserMedia / WebSocket，
 * 不用假 timers 驱动业务逻辑（只用来断言「没有定时器被留下」）。
 * ============================================================
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceSession } from './VoiceSession';

/** 可控的媒体流：记录每条轨道的 stop() 调用次数 */
function makeFakeStream(trackStops: number[]): MediaStream {
  const track = {
    enabled: true,
    kind: 'audio',
    stop: () => trackStops.push(1),
    applyConstraints: () => Promise.resolve(),
  };
  return {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
}

class FakeAudioParam {
  value = 0;
}

class FakeNode {
  connect(): void {}
  disconnect(): void {}
}

class FakeGainNode extends FakeNode {
  gain = new FakeAudioParam();
}

class FakeCompressorNode extends FakeNode {
  threshold = new FakeAudioParam();
  knee = new FakeAudioParam();
  ratio = new FakeAudioParam();
  attack = new FakeAudioParam();
  release = new FakeAudioParam();
}

/**
 * 无 audioWorklet 的 AudioContext：Denoiser.prepare / RoomRecorder.prepareWorklet
 * 会因此走「立即 resolve 的降级分支」，不必再 mock worklet 模块加载。
 */
class FakeAudioContext {
  state: AudioContextState = 'suspended';
  destination = new FakeNode();
  sampleRate = 48000;
  resume = () => Promise.resolve();
  close = () => Promise.resolve();
  createGain = () => new FakeGainNode();
  createDynamicsCompressor = () => new FakeCompressorNode();
  createAnalyser = () => new FakeNode();
  createMediaStreamDestination = () => ({ ...new FakeNode(), stream: makeFakeStream([]) });
  createMediaStreamSource = () => new FakeNode();
}

const { getVoiceIceServersMock, fetchVoiceTicketMock } = vi.hoisted(() => ({
  getVoiceIceServersMock: vi.fn(async () => [] as RTCIceServer[]),
  // 信令建连前要先换一次性票据（见 wsSignaling.resolveCredential）
  fetchVoiceTicketMock: vi.fn(async () => ({ ticket: 'tk-test' })),
}));

vi.mock('../api/voice', () => ({
  getVoiceIceServers: getVoiceIceServersMock,
  fetchVoiceTicket: fetchVoiceTicketMock,
}));

/** 可驱动 onopen/onclose 的假 WebSocket（用于验证终止类关闭码的会话收尾） */
class DrivableWs {
  static instances: DrivableWs[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) {
    DrivableWs.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {}
}

describe('VoiceSession 生命周期', () => {
  let trackStops: number[];
  let wsConstructed: number;
  let session: VoiceSession | undefined;

  beforeEach(() => {
    trackStops = [];
    wsConstructed = 0;
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal(
      'WebSocket',
      class {
        readyState = 0;
        close(): void {}
        send(): void {}
        constructor() {
          wsConstructed++;
        }
      }
    );
    // jsdom 无 navigator.mediaDevices
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      writable: true,
      value: { getUserMedia: vi.fn() },
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('授权弹窗期间退出房间：麦克风被停掉，且不复活任何轮询定时器', async () => {
    let getUserMediaCalled = false;
    (navigator.mediaDevices.getUserMedia as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      getUserMediaCalled = true;
      // 用户还没点授权就已经退出房间（真机上授权弹窗可停留数秒）
      session!.leave();
      return Promise.resolve(makeFakeStream(trackStops));
    });

    session = new VoiceSession(
      { userId: 42, username: 'tester', avatar: null },
      {
        onStatus: () => {},
        onParticipants: () => {},
        onSpeaking: () => {},
        onError: () => {},
        onClosed: () => {},
        onPeerQuality: () => {},
        onRecordingChange: () => {},
        onShareChanged: () => {},
        onShareVideo: () => {},
        onShareStats: () => {},
        onChatMessage: () => {},
        onChatCleared: () => {},
      }
    );

    await session.join(1);

    expect(getUserMediaCalled).toBe(true);
    // 1. 迟到的麦克风流必须已被停止（修复前为 0 次）
    expect(trackStops.length).toBe(1);
    // 2. 不得打开信令 WS
    expect(wsConstructed).toBe(0);
    // 3. 不得留下说话检测 / 质量评估定时器（修复前为 2 个）
    expect(vi.getTimerCount()).toBe(0);
  });

  it('正常路径不受影响：未销毁时照常建立信令连接与轮询', async () => {
    (navigator.mediaDevices.getUserMedia as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeFakeStream(trackStops)
    );

    session = new VoiceSession(
      { userId: 42, username: 'tester', avatar: null },
      {
        onStatus: () => {},
        onParticipants: () => {},
        onSpeaking: () => {},
        onError: () => {},
        onClosed: () => {},
        onPeerQuality: () => {},
        onRecordingChange: () => {},
        onShareChanged: () => {},
        onShareVideo: () => {},
        onShareStats: () => {},
        onChatMessage: () => {},
        onChatCleared: () => {},
      }
    );

    await session.join(1);

    expect(trackStops.length).toBe(0);
    expect(wsConstructed).toBe(1);
    // 说话检测轮询 + 质量评估轮询
    expect(vi.getTimerCount()).toBe(2);

    // 主动退出后应全部回收
    session.leave();
    expect(trackStops.length).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('★ 4004（同 IP 连接过多）：会话终止并给出明确原因，不再自动重连', async () => {
    (navigator.mediaDevices.getUserMedia as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeFakeStream(trackStops)
    );
    vi.stubGlobal('WebSocket', DrivableWs);
    DrivableWs.instances = [];

    const closed: string[] = [];
    const statuses: string[] = [];
    session = new VoiceSession(
      { userId: 42, username: 'tester', avatar: null },
      {
        onStatus: (s) => statuses.push(s),
        onParticipants: () => {},
        onSpeaking: () => {},
        onError: () => {},
        onClosed: (reason) => closed.push(reason),
        onPeerQuality: () => {},
        onRecordingChange: () => {},
        onShareChanged: () => {},
        onShareVideo: () => {},
        onShareStats: () => {},
        onChatMessage: () => {},
        onChatCleared: () => {},
      }
    );

    await session.join(1);
    // 票据换取是异步的：推进微任务直到 WS 建好
    for (let i = 0; i < 6; i++) await Promise.resolve();
    const ws = DrivableWs.instances[0];
    expect(ws, '应已建立信令连接').toBeDefined();

    ws!.onclose?.({ code: 4004 });

    expect(closed).toEqual(['同一网络下的语音连接过多，请稍后再试']);
    // 不用 Array.prototype.at：client 的 lib 是 ES2020（与仓库既有约定一致）
    expect(statuses[statuses.length - 1]).toBe('ended');
    // 终止后不得留下说话检测/质量评估定时器
    expect(vi.getTimerCount()).toBe(0);
  });
});
