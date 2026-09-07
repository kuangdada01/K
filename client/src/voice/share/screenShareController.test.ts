/**
 * ============================================================
 * 屏幕共享状态机单测（voice/share/screenShareController.test）
 * ============================================================
 * 用 fake sink + fake MediaStream 验证状态迁移与回调时序（§3 语音域
 * 拆分的第一步：把「重连对账 / 服务端 share-changed 对账」固化进
 * 子模块并单测）。所有断言针对音频/视频之外的可观察序列：
 * 回调顺序、信令上行、共享者状态、捕获流生命周期。
 * ============================================================
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScreenShareController, type ScreenShareSink } from './screenShareController';
import type { VoiceParticipant } from '../../types';

class FakeTrack {
  kind: string;
  contentHint = '';
  onended: (() => void) | null = null;
  stopped = false;
  constructor(kind: string) {
    this.kind = kind;
  }
  getSettings(): MediaTrackSettings {
    return { frameRate: 30, width: 1920, height: 1080 };
  }
  stop(): void {
    this.stopped = true;
  }
}

/** jsdom 无 MediaStream：控制器里 `new MediaStream([track])` 需要全局 stub */
class FakeMediaStream {
  tracks: FakeTrack[];
  constructor(tracks: FakeTrack[] = []) {
    this.tracks = tracks;
  }
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
  getVideoTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === 'video');
  }
  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
}

const SELF_ID = 7;
const OTHER_ID = 5;

function makeSink(rec: string[]): ScreenShareSink {
  return {
    getSelfUserId: () => SELF_ID,
    onSelfSharingChanged: (s) => rec.push(`selfSharing:${s}`),
    sendShareStart: (a) => rec.push(`shareStart:${a}`),
    sendShareStop: () => rec.push('shareStop'),
    emitParticipants: () => rec.push('participants'),
    getVideoSenders: () => [],
    getPeerCount: () => 0,
    attachShareTracksToAll: () => rec.push('attachAll'),
    detachShareTracksFromAll: () => rec.push('detachAll'),
    applyShareQuality: () => rec.push('applyQuality'),
    onShareVideo: (s) => rec.push(s ? 'video:set' : 'video:null'),
    onShareChanged: (i) => rec.push(`changed:${i.userId}:${i.audio}`),
    onShareStats: () => rec.push('stats'),
    onShareQualityChange: (q) => rec.push(`qualityIdx:${q}`),
    attachRemoteShareAudio: () => rec.push('remoteAudio'),
    disposeRemoteShareAudio: () => rec.push('disposeRemoteAudio'),
    applyShareMuted: (m) => rec.push(`muted:${m}`),
  };
}

const participant = (userId: number, sharing = false): VoiceParticipant => ({
  userId,
  username: `u${userId}`,
  avatar: null,
  muted: false,
  listener: false,
  sharing,
});

describe('ScreenShareController', () => {
  let rec: string[];
  let sink: ScreenShareSink;
  let h: ScreenShareController;

  beforeEach(() => {
    rec = [];
    sink = makeSink(rec);
    h = new ScreenShareController(sink);
    vi.stubGlobal('MediaStream', FakeMediaStream);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('初始状态：空闲 / 默认档位 / 默认静音 / 无共享者', () => {
    expect(h.isSharing()).toBe(false);
    expect(h.getShareQuality()).toBe('1080p30'); // 干净 localStorage → 默认档
    expect(h.getShareMuted()).toBe(true);
    expect(h.shareSharer).toBeNull();
    expect(h.shareStream).toBeNull();
  });

  it('start：登记捕获流并挂到对端，回调时序与原实现一致', () => {
    const video = new FakeTrack('video');
    const audio = new FakeTrack('audio');
    const stream = new FakeMediaStream([video, audio]);
    h.start(stream as unknown as MediaStream);

    expect(rec).toEqual([
      'selfSharing:true',
      'participants',
      'shareStart:true', // 携带系统声音
      'attachAll',
      `changed:${SELF_ID}:true`,
      'video:set', // 本地画面回显
    ]);
    expect(h.isSharing()).toBe(true);
    expect(h.withShareAudio).toBe(true);
    expect(h.shareSendVideoStream).not.toBeNull();
    expect(h.shareSendAudioStream).not.toBeNull();
    expect(video.onended).not.toBeNull();
  });

  it('start：无系统声音时 share-start 与音频包装流为空', () => {
    const stream = new FakeMediaStream([new FakeTrack('video')]);
    h.start(stream as unknown as MediaStream);
    expect(rec).toContain('shareStart:false');
    expect(h.shareSendAudioStream).toBeNull();
    expect(h.withShareAudio).toBe(false);
  });

  it('start：开启清晰文字模式时捕获轨道 contentHint=detail', () => {
    h.setShareSharpText(true);
    const video = new FakeTrack('video');
    h.start(new FakeMediaStream([video]) as unknown as MediaStream);
    expect(video.contentHint).toBe('detail');
  });

  it('浏览器"停止共享"条（轨道 onended）→ 与主动停止同一路径，含 share-stop 上行', () => {
    const video = new FakeTrack('video');
    h.start(new FakeMediaStream([video]) as unknown as MediaStream);
    rec.length = 0;
    video.onended?.();
    expect(rec).toContain('shareStop');
    expect(video.stopped).toBe(true);
    expect(h.isSharing()).toBe(false);
  });

  it('stop(true)：摘除全部对端 track、停捕获流、发 share-stop、清 UI 回调', () => {
    const video = new FakeTrack('video');
    h.start(new FakeMediaStream([video]) as unknown as MediaStream);
    rec.length = 0;
    h.stop();
    expect(rec).toEqual([
      'selfSharing:false',
      'detachAll',
      'participants',
      'shareStop',
      'video:null',
      'changed:null:false',
    ]);
    expect(video.stopped).toBe(true);
    expect(h.shareStream).toBeNull();
    expect(h.shareSendVideoStream).toBeNull();
  });

  it('stop(false)：被抢占/服务端兜底路径不再回发 share-stop', () => {
    h.start(new FakeMediaStream([new FakeTrack('video')]) as unknown as MediaStream);
    rec.length = 0;
    h.stop(false);
    expect(rec).not.toContain('shareStop');
    expect(rec).toContain('changed:null:false');
  });

  it('stop：空闲时早退（无任何副作用）', () => {
    h.stop();
    expect(rec).toEqual([]);
  });

  describe('重连对账（onWsClosed）', () => {
    it('共享方断线：静默停止本地共享（不发 share-stop），捕获流被回收', () => {
      const video = new FakeTrack('video');
      h.start(new FakeMediaStream([video]) as unknown as MediaStream);
      rec.length = 0;
      h.onWsClosed();
      // stop(false) 序列 + 自己正是共享者被 stop 清掉 → 无后续 sharer 清理
      expect(rec).toEqual([
        'selfSharing:false',
        'detachAll',
        'participants',
        'video:null',
        'changed:null:false',
      ]);
      expect(rec).not.toContain('shareStop');
      expect(video.stopped).toBe(true);
      expect(h.isSharing()).toBe(false);
      expect(h.shareSharer).toBeNull();
    });

    it('观看方断线：清掉共享者状态与舞台（dispose 音频元素 + 清 UI）', () => {
      h.onShareChanged(OTHER_ID, true, true);
      rec.length = 0;
      h.onWsClosed();
      expect(rec).toEqual(['disposeRemoteAudio', 'video:null', 'changed:null:false']);
      expect(h.isSharing()).toBe(false); // 非共享方：无采集清理
      expect(h.shareSharer).toBeNull();
    });

    it('空闲断线：无任何副作用', () => {
      h.onWsClosed();
      expect(rec).toEqual([]);
    });
  });

  describe('服务端 share-changed 对账', () => {
    it('他人开始共享 → 立共享者状态并通知舞台', () => {
      h.onShareChanged(OTHER_ID, true, true);
      expect(h.shareSharer).toEqual({ userId: OTHER_ID, audio: true });
      expect(rec).toEqual([`changed:${OTHER_ID}:true`]);
    });

    it('共享者结束共享 → 清状态 + dispose 音频 + 清画面 + 通知', () => {
      h.onShareChanged(OTHER_ID, true, true);
      rec.length = 0;
      h.onShareChanged(OTHER_ID, false, false);
      expect(h.shareSharer).toBeNull();
      expect(rec).toEqual(['disposeRemoteAudio', 'video:null', 'changed:null:false']);
    });

    it('自己被服务端判定不再共享（被抢占）→ 本地兜底停止，回调与原实现一样双发', () => {
      h.start(new FakeMediaStream([new FakeTrack('video')]) as unknown as MediaStream);
      rec.length = 0;
      h.onShareChanged(SELF_ID, false, false);
      // stop(false) 的收尾回调 + case 尾部 onShareChanged({null, audio}) 各一次
      expect(rec).toEqual([
        'selfSharing:false',
        'detachAll',
        'participants',
        'video:null',
        'changed:null:false',
        'changed:null:false',
      ]);
      expect(rec).not.toContain('shareStop');
      expect(h.isSharing()).toBe(false);
    });

    it('共享者切换：新 share-changed 直接覆盖旧共享者', () => {
      h.onShareChanged(OTHER_ID, true, false);
      h.onShareChanged(9, true, true);
      expect(h.shareSharer).toEqual({ userId: 9, audio: true });
    });

    it('非当前共享者结束共享（他人状态广播）→ 不影响本地', () => {
      h.onShareChanged(OTHER_ID, true, true);
      rec.length = 0;
      h.onShareChanged(9, false, false);
      expect(h.shareSharer).toEqual({ userId: OTHER_ID, audio: true });
      expect(rec).toEqual(['changed:null:false']);
    });
  });

  it('onForceStop：观看中收到抢占广播（本地未共享）→ 早退无副作用', () => {
    h.onShareChanged(OTHER_ID, true, true);
    rec.length = 0;
    h.onForceStop();
    expect(rec).toEqual([]);
    expect(h.shareSharer).toEqual({ userId: OTHER_ID, audio: true }); // 不影响观看状态
  });

  describe('成员离开 / 加入', () => {
    it('共享者离开 → 关闭舞台与共享声音', () => {
      h.onShareChanged(OTHER_ID, true, true);
      rec.length = 0;
      h.onPeerLeft(OTHER_ID);
      expect(h.shareSharer).toBeNull();
      expect(rec).toEqual(['disposeRemoteAudio', 'video:null', 'changed:null:false']);
    });

    it('非共享者离开 → 无副作用', () => {
      h.onShareChanged(OTHER_ID, true, true);
      rec.length = 0;
      h.onPeerLeft(9);
      expect(rec).toEqual([]);
    });

    it('onJoined：房间里已有共享者 → 立状态与徽标（audio 先按 false）', () => {
      h.onJoined([participant(1), participant(OTHER_ID, true)]);
      expect(h.shareSharer).toEqual({ userId: OTHER_ID, audio: false });
      expect(rec).toEqual([`changed:${OTHER_ID}:false`]);
    });

    it('onJoined：无共享者 → 无副作用', () => {
      h.onJoined([participant(1), participant(2)]);
      expect(rec).toEqual([]);
    });
  });

  describe('画面 / 共享声音到达', () => {
    it('onRemoteVideo：立共享者并保留已有 audio 标志', () => {
      h.onShareChanged(OTHER_ID, true, true);
      rec.length = 0;
      const stream = new FakeMediaStream([new FakeTrack('video')]);
      h.onRemoteVideo(OTHER_ID, stream as unknown as MediaStream);
      expect(h.shareSharer).toEqual({ userId: OTHER_ID, audio: true });
      expect(rec).toEqual(['video:set']);
    });

    it('onRemoteShareAudio：挂 audio 元素（带当前静音偏好）+ 通知舞台 audio=true', () => {
      h.onShareChanged(OTHER_ID, true, false);
      rec.length = 0;
      h.onRemoteShareAudio(new FakeMediaStream() as unknown as MediaStream);
      expect(rec).toEqual(['remoteAudio', `changed:${OTHER_ID}:true`]);
    });

    it('onRemoteShareAudio：无共享者状态时只挂元素不通知', () => {
      h.onRemoteShareAudio(new FakeMediaStream() as unknown as MediaStream);
      expect(rec).toEqual(['remoteAudio']);
    });
  });

  describe('偏好与设置', () => {
    it('setShareQuality：应用档位 + 通知 UI + 持久化（新实例读回）', () => {
      h.setShareQuality('720p30');
      expect(rec).toEqual(['applyQuality', 'qualityIdx:720p30']);
      expect(localStorage.getItem('voice:shareQuality')).toBe('720p30');
      const h2 = new ScreenShareController(makeSink([]));
      expect(h2.getShareQuality()).toBe('720p30');
    });

    it('setShareQuality：非法档位忽略', () => {
      h.setShareQuality('4k60' as never);
      expect(rec).toEqual([]);
      expect(h.getShareQuality()).toBe('1080p30');
    });

    it('setShareSharpText：共享中实时改捕获轨道 contentHint（开=detail / 关=空）', () => {
      const video = new FakeTrack('video');
      h.start(new FakeMediaStream([video]) as unknown as MediaStream);
      rec.length = 0;
      h.setShareSharpText(true);
      expect(video.contentHint).toBe('detail');
      h.setShareSharpText(false);
      expect(video.contentHint).toBe('');
      // 两次都应用质量档
      expect(rec.filter((c) => c === 'applyQuality').length).toBe(2);
    });

    it('setShareMuted：透传静音偏好给会话（audio 元素侧）', () => {
      h.setShareMuted(false);
      expect(rec).toEqual(['muted:false']);
      expect(h.getShareMuted()).toBe(false);
    });
  });

  it('destroy：会话级清理，不再触发任何 UI 回调', () => {
    const video = new FakeTrack('video');
    h.start(new FakeMediaStream([video, new FakeTrack('audio')]) as unknown as MediaStream);
    h.onShareChanged(OTHER_ID, true, true);
    rec.length = 0;
    h.destroy();
    expect(rec).toEqual(['disposeRemoteAudio']);
    expect(video.stopped).toBe(true);
    expect(h.isSharing()).toBe(false);
    expect(h.shareSharer).toBeNull();
    expect(h.shareStream).toBeNull();
    expect(h.shareSendVideoStream).toBeNull();
    expect(h.shareSendAudioStream).toBeNull();
  });
});
