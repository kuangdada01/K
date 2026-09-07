/**
 * ============================================================
 * WebRTC Mesh 管理单测（voice/mesh/meshManager.test）
 * ============================================================
 * fake RTCPeerConnection 验证（§3.1 最后一个模块，协商逻辑最重）：
 * - ensurePeer 建连/发送轨道/事件接线/polite 角色
 * - 完美协商：offer 冲突时非礼貌方暂存补处理、礼貌方接受回滚、
 *   过期 answer 忽略、候选在远端描述就绪前缓存
 * - ICE 重启（最多 2 次、userId 较小一方发起）
 * - ontrack 分流（共享画面/共享声音/麦克风）与 removePeer/cleanupPeers
 *   的清理链（音频/质量/说话/共享舞台）
 * ============================================================
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeshManager, type MeshManagerOptions } from './meshManager';
import type { PeerEntry } from './meshPeer';
import type { VoiceParticipant } from '../../types';

class FakeMediaStream {
  id = `stream-${Math.random()}`;
  tracks: { kind: string }[] = [];
  constructor(tracks: { kind: string }[] = []) {
    this.tracks = tracks;
  }
  getTracks(): { kind: string }[] {
    return this.tracks;
  }
}

interface FakeSender {
  track: MediaStreamTrack | null;
  getParameters(): RTCRtpSendParameters;
  setParameters: ReturnType<typeof vi.fn>;
}

class FakePC {
  static OPEN = 1;
  static instances: FakePC[] = [];
  signalingState: RTCSignalingState = 'stable';
  connectionState: 'connected' | 'failed' | 'disconnected' = 'connected';
  iceServers: RTCIceServer[];
  transceivers: {
    kind: string;
    sender: FakeSender;
    direction: string | undefined;
    setCodecPreferences: ReturnType<typeof vi.fn>;
  }[] = [];
  remoteDesc: unknown = null;
  localDesc: unknown = null;
  closed = false;
  addIceCandidates: RTCIceCandidateInit[] = [];
  onicecandidate: ((e: { candidate: { toJSON(): unknown } | null }) => void) | null = null;
  ontrack: ((e: { track: { kind: string }; streams: MediaStream[]; receiver: unknown }) => void) | null =
    null;
  onnegotiationneeded: (() => void) | null = null;
  onsignalingstatechange: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

  constructor(init: { iceServers: RTCIceServer[] }) {
    this.iceServers = init.iceServers;
    FakePC.instances.push(this);
  }

  addTrack(track: MediaStreamTrack, _stream: MediaStream): FakeSender {
    const sender: FakeSender = {
      track,
      getParameters: () => ({ encodings: [{}] }) as RTCRtpSendParameters,
      setParameters: vi.fn(async () => {}),
    };
    this.transceivers.push({ kind: 'audio', sender, direction: 'sendrecv', setCodecPreferences: vi.fn() });
    return sender;
  }

  addTransceiver(
    _kind: string,
    init?: { direction?: RTCRtpTransceiverDirection }
  ): { sender: FakeSender; setCodecPreferences: ReturnType<typeof vi.fn> } {
    const t = {
      kind: 'audio',
      sender: {
        track: null,
        getParameters: () => ({ encodings: [{}] }) as RTCRtpSendParameters,
        setParameters: vi.fn(async () => {}),
      },
      direction: init?.direction,
      setCodecPreferences: vi.fn(),
    };
    this.transceivers.push(t);
    return t;
  }

  getTransceivers(): typeof this.transceivers {
    return this.transceivers;
  }

  async createOffer(_options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'offer-sdp' };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'answer-sdp' };
  }

  async setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.localDesc = desc;
    this.signalingState = desc.type === 'offer' ? 'have-local-offer' : 'stable';
    this.onsignalingstatechange?.();
    return Promise.resolve();
  }

  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDesc = desc;
    this.signalingState = desc.type === 'offer' ? 'have-remote-offer' : 'stable';
    this.onsignalingstatechange?.();
    return Promise.resolve();
  }

  async addIceCandidate(c: RTCIceCandidateInit): Promise<void> {
    this.addIceCandidates.push(c);
    return Promise.resolve();
  }

  removeTrack(): void {}

  close(): void {
    this.closed = true;
  }
}

const SELF_ID = 7;
const PEER_ID = 5;

function participant(userId: number): VoiceParticipant {
  return { userId, username: `u${userId}`, avatar: null, muted: false, listener: false, sharing: false };
}

describe('MeshManager', () => {
  let calls: string[];
  let attachShareTracks: ReturnType<typeof vi.fn<(entry: PeerEntry) => void>>;
  let opts: MeshManagerOptions;
  let m: MeshManager;
  let sendTrack: MediaStreamTrack | null;

  beforeEach(() => {
    FakePC.instances = [];
    vi.stubGlobal('RTCPeerConnection', FakePC);
    vi.stubGlobal('MediaStream', FakeMediaStream);
    calls = [];
    attachShareTracks = vi.fn<(entry: PeerEntry) => void>();
    sendTrack = { enabled: true } as MediaStreamTrack;
    opts = {
      getSelf: () => participant(SELF_ID),
      getSendTrack: () => sendTrack,
      getIceServers: () => [{ urls: ['stun:test'] }],
      isMusicMode: () => false,
      isDestroyed: () => false,
      sendSignal: (to, data) => calls.push(`signal:${to}:${data.type}`),
      onRemoteVideo: (_userId, _stream) => calls.push('remoteVideo'),
      onRemoteShareAudio: () => calls.push('remoteShareAudio'),
      attachPeerAudio: (_stream, volume) => {
        calls.push(`attachAudio:${volume}`);
        return {
          source: {} as MediaStreamAudioSourceNode,
          analyser: { fftSize: 512 } as AnalyserNode,
          gain: { gain: { value: 0 } } as GainNode,
          buffer: new Uint8Array(512),
          hiddenEl: document.createElement('audio'),
        };
      },
      attachPeerGainToRecorder: () => calls.push('recGain'),
      getPeerVolume: () => 0.6,
      forgetPeerSpeaking: (userId) => calls.push(`forgetSpeaking:${userId}`),
      onPeerLeftShareStage: (userId) => calls.push(`shareLeft:${userId}`),
      forgetPeerQuality: (userId) => calls.push(`forgetQuality:${userId}`),
      forgetAllQuality: () => calls.push('forgetAllQuality'),
      disposePeerAudio: () => calls.push('disposeAudio'),
      attachShareTracks,
      onParticipantsChanged: () => calls.push('participants'),
    };
    m = new MeshManager(opts);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ensurePeer：建连（ICE 配置透传）+ 发送轨道 addTrack + 编解码偏好 + 事件接线', () => {
    const entry = m.ensurePeer(participant(PEER_ID));
    const pc = FakePC.instances[0]!;
    expect(pc.iceServers).toEqual([{ urls: ['stun:test'] }]);
    expect(pc.transceivers.length).toBe(1); // addTrack 建收发器
    expect(entry.audioTransceiver).not.toBeNull();
    expect(entry.polite).toBe(true); // 7 > 5 → id 大者为 polite（冲突时让步）
    expect(entry.negotiateSuppressed).toBe(true);
    expect(pc.onicecandidate).not.toBeNull();
    expect(pc.ontrack).not.toBeNull();
    expect(pc.onnegotiationneeded).not.toBeNull();
    expect(pc.onsignalingstatechange).not.toBeNull();
    expect(pc.onconnectionstatechange).not.toBeNull();
  });

  it('ensurePeer：听者模式（无发送轨道）→ recvonly 收发器；重复调用刷新参与者信息', () => {
    sendTrack = null;
    const entry = m.ensurePeer(participant(PEER_ID));
    const pc = FakePC.instances[0]!;
    expect(pc.transceivers[0]!.direction).toBe('recvonly');
    const again = m.ensurePeer(participant(PEER_ID));
    expect(again).toBe(entry); // 复用条目
    expect(FakePC.instances).toHaveLength(1);
  });

  it('initiateOffer：createOffer → setLocalDescription(offer) → 信令上行', async () => {
    const entry = m.ensurePeer(participant(PEER_ID));
    await m.initiateOffer(entry);
    const pc = FakePC.instances[0]!;
    expect(pc.localDesc).toEqual({ type: 'offer', sdp: 'offer-sdp' });
    expect(calls).toContain(`signal:${PEER_ID}:offer`);
  });

  it('handleSignal answer：无在途 offer 时忽略过期 answer', async () => {
    m.ensurePeer(participant(PEER_ID));
    await m.handleSignal(PEER_ID, { type: 'answer', sdp: 'late' });
    expect(FakePC.instances[0]!.remoteDesc).toBeNull();
  });

  it('handleSignal offer：正常应答流程（setRemoteDescription → createAnswer → 上行 answer + 补挂共享 track）', async () => {
    const entry = m.ensurePeer(participant(PEER_ID));
    await m.handleSignal(PEER_ID, { type: 'offer', sdp: 'remote-offer' });
    const pc = FakePC.instances[0]!;
    expect(pc.remoteDesc).toEqual({ type: 'offer', sdp: 'remote-offer' });
    expect(pc.localDesc).toEqual({ type: 'answer', sdp: 'answer-sdp' });
    expect(calls).toContain(`signal:${PEER_ID}:answer`);
    expect(entry.negotiateSuppressed).toBe(false);
    expect(attachShareTracks).toHaveBeenCalledWith(entry);
  });

  describe('完美协商', () => {
    it('非礼貌方冲突：远端 offer 暂存，本端协商落定（stable）后补处理', async () => {
      // self 7 < peer 10 → 非礼貌方（id 小者坚持己见，冲突时丢弃来包并暂存）
      const BIG = 10;
      const entry = m.ensurePeer(participant(BIG));
      const pc = FakePC.instances[0]!;
      expect(entry.polite).toBe(false);
      entry.makingOffer = true; // 本端正在发起协商
      pc.signalingState = 'have-local-offer';
      await m.handleSignal(BIG, { type: 'offer', sdp: 'collided' });
      // 冲突：不 setRemoteDescription，暂存
      expect(pc.remoteDesc).toBeNull();
      expect(entry.pendingOffer).toEqual({ sdp: 'collided' });
      // 本端协商落定 → stable 事件 → 补处理
      entry.makingOffer = false;
      pc.signalingState = 'stable';
      pc.onsignalingstatechange?.();
      expect(pc.remoteDesc).toEqual({ type: 'offer', sdp: 'collided' });
      expect(entry.pendingOffer).toBeNull();
      await vi.waitFor(() => expect(calls).toContain(`signal:${BIG}:answer`));
    });

    it('礼貌方冲突：接受远端 offer（浏览器自动回滚本地半成品）', async () => {
      // self 7 > peer 5 → 礼貌方（id 大者让步）
      const entry = m.ensurePeer(participant(PEER_ID));
      const pc = FakePC.instances[0]!;
      expect(entry.polite).toBe(true);
      entry.makingOffer = true;
      pc.signalingState = 'have-local-offer';
      await m.handleSignal(PEER_ID, { type: 'offer', sdp: 'collided' });
      expect(entry.pendingOffer).toBeNull(); // 不暂存，直接接受
      expect(pc.remoteDesc).toEqual({ type: 'offer', sdp: 'collided' });
    });
  });

  it('candidate：远端描述就绪前缓存，offer 到达后统一灌入', async () => {
    const entry = m.ensurePeer(participant(PEER_ID));
    const pc = FakePC.instances[0]!;
    await m.handleSignal(PEER_ID, { type: 'candidate', candidate: { candidate: 'c1' } });
    expect(entry.pendingCandidates).toHaveLength(1);
    expect(pc.addIceCandidates).toHaveLength(0);
    await m.handleSignal(PEER_ID, { type: 'offer', sdp: 'remote-offer' });
    expect(pc.addIceCandidates).toEqual([{ candidate: 'c1' }]);
    expect(entry.pendingCandidates).toHaveLength(0);
  });

  it('candidate：描述就绪后直接 addIceCandidate；坏候选静默忽略', async () => {
    m.ensurePeer(participant(PEER_ID));
    const pc = FakePC.instances[0]!;
    await m.handleSignal(PEER_ID, { type: 'offer', sdp: 'remote-offer' }); // remoteDescSet=true
    await m.handleSignal(PEER_ID, { type: 'candidate', candidate: { candidate: 'c2' } });
    expect(pc.addIceCandidates).toEqual([{ candidate: 'c2' }]);
    pc.addIceCandidate = vi.fn(async () => {
      throw new Error('bad candidate');
    });
    await m.handleSignal(PEER_ID, { type: 'candidate', candidate: { candidate: 'c3' } }); // 不抛
  });

  describe('ICE 重启', () => {
    it('userId 较小一方发起（最多 2 次），大者不发起', async () => {
      // self 7 > peer 5：self 不是较小方 → 不发起
      m.ensurePeer(participant(PEER_ID));
      const pc = FakePC.instances[0]!;
      pc.connectionState = 'failed';
      pc.onconnectionstatechange?.();
      expect(calls).not.toContain(`signal:${PEER_ID}:offer`);

      // self 3 < peer 5：较小方发起，最多 2 次
      opts.getSelf = () => participant(3);
      m = new MeshManager(opts);
      m.ensurePeer(participant(PEER_ID));
      const pc2 = FakePC.instances[1]!;
      pc2.connectionState = 'failed';
      pc2.onconnectionstatechange?.();
      await vi.waitFor(() => expect(calls.filter((c) => c === `signal:${PEER_ID}:offer`)).toHaveLength(1));
      pc2.onconnectionstatechange?.();
      await vi.waitFor(() => expect(calls.filter((c) => c === `signal:${PEER_ID}:offer`)).toHaveLength(2));
      pc2.onconnectionstatechange?.(); // 第三次不再发起
      await Promise.resolve();
      expect(calls.filter((c) => c === `signal:${PEER_ID}:offer`)).toHaveLength(2);
    });
  });

  describe('ontrack 分流', () => {
    it('video → 共享画面回调（含 jitterBufferTarget 设定）', () => {
      m.ensurePeer(participant(PEER_ID));
      const pc = FakePC.instances[0]!;
      pc.ontrack?.({
        track: { kind: 'video' },
        streams: [new FakeMediaStream()] as unknown as MediaStream[],
        receiver: {},
      });
      expect(calls).toContain('remoteVideo');
      expect(calls).not.toContain('attachAudio:0.6');
    });

    it('首条音频流 → 音频图接入（音量偏好 + 录制总线 + micStreamId）', () => {
      const entry = m.ensurePeer(participant(PEER_ID));
      const pc = FakePC.instances[0]!;
      const stream = new FakeMediaStream() as unknown as MediaStream;
      pc.ontrack?.({ track: { kind: 'audio' }, streams: [stream], receiver: {} });
      expect(calls).toContain('attachAudio:0.6');
      expect(calls).toContain('recGain');
      expect(entry.micStreamId).toBe(stream.id);
      expect(entry.audio).not.toBeNull();
    });

    it('同对端第二条音频流 → 共享系统声音', () => {
      const entry = m.ensurePeer(participant(PEER_ID));
      const pc = FakePC.instances[0]!;
      entry.micStreamId = 'mic-1';
      pc.ontrack?.({
        track: { kind: 'audio' },
        streams: [{ id: 'share-2' }] as unknown as MediaStream[],
        receiver: {},
      });
      expect(calls).toContain('remoteShareAudio');
      expect(calls).not.toContain('attachAudio:0.6');
    });
  });

  it('onnegotiationneeded：初始协商被抑制；解除后自动重协商', async () => {
    const entry = m.ensurePeer(participant(PEER_ID));
    const pc = FakePC.instances[0]!;
    pc.onnegotiationneeded?.();
    expect(calls).not.toContain(`signal:${PEER_ID}:offer`); // negotiateSuppressed
    entry.negotiateSuppressed = false;
    pc.onnegotiationneeded?.();
    await vi.waitFor(() => expect(calls).toContain(`signal:${PEER_ID}:offer`));
  });

  it('removePeer：关闭 PC + 清理音频/质量/说话/共享舞台；不存在时无副作用', () => {
    m.ensurePeer(participant(PEER_ID));
    const pc = FakePC.instances[0]!;
    m.removePeer(PEER_ID);
    expect(pc.closed).toBe(true);
    expect(calls).toEqual(['forgetQuality:5', 'forgetSpeaking:5', 'shareLeft:5']);
    expect(m.peers.size).toBe(0);

    calls.length = 0;
    m.removePeer(999);
    expect(calls).toEqual([]);
  });

  it('cleanupPeers：销毁全部连接并清全部质量数据', () => {
    m.ensurePeer(participant(PEER_ID));
    m.ensurePeer(participant(9));
    const [pc1, pc2] = FakePC.instances;
    m.cleanupPeers();
    expect(pc1!.closed).toBe(true);
    expect(pc2!.closed).toBe(true);
    expect(m.peers.size).toBe(0);
    expect(calls).toContain('forgetAllQuality');
  });
});
