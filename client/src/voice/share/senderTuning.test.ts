/**
 * ============================================================
 * 屏幕共享发送端参数调优单测（voice/share/senderTuning）
 * ============================================================
 * 这几个函数此前是 VoiceSession 的私有方法，只能间接验证；而它们直接决定
 * 「共享画面糊 / 卡 / CPU 打满」：编解码偏好、码率、分辨率缩放、降级策略。
 * 抽出后可以在这里对着假 sender / transceiver 直接断言参数。
 * ============================================================
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { applyShareQualityToSender, applyShareQualityToSenders, preferH264ForSender } from './senderTuning';
import { SHARE_QUALITY_PRESETS } from '../types';

/** jsdom 没有 RTCRtpSender：按需 stub 出 getCapabilities */
function stubCodecCapabilities(codecs: { mimeType: string }[] | null | 'throw'): void {
  vi.stubGlobal('RTCRtpSender', {
    getCapabilities: () => {
      if (codecs === 'throw') throw new Error('not supported');
      return codecs === null ? null : { codecs };
    },
  });
}

/** 假 RTCRtpSender：记录 setParameters 收到的参数 */
type FakeEncoding = { maxBitrate?: number; scaleResolutionDownBy?: number };
type FakeParams = { encodings?: FakeEncoding[] } & Record<string, unknown>;

function fakeSender(initial?: { encodings: FakeEncoding[] }) {
  // exactOptionalPropertyTypes 下不接受「显式 undefined 的可选属性」，故按需构造
  const params: FakeParams = initial ? { encodings: initial.encodings } : {};
  const setParameters = vi.fn(async () => {});
  return {
    params,
    setParameters,
    sender: { getParameters: () => params, setParameters } as unknown as RTCRtpSender,
  };
}

/** 假 transceiver：记录 setCodecPreferences 的入参 */
function fakeTransceiver() {
  const setCodecPreferences = vi.fn();
  return {
    setCodecPreferences,
    transceiver: { setCodecPreferences } as unknown as RTCRtpTransceiver,
  };
}

describe('preferH264ForSender', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('把 H.264 排到最前，其余编解码保持原有相对顺序', () => {
    stubCodecCapabilities([
      { mimeType: 'video/VP8' },
      { mimeType: 'video/H264' },
      { mimeType: 'video/VP9' },
      { mimeType: 'video/h264' },
    ]);

    const { transceiver, setCodecPreferences } = fakeTransceiver();
    preferH264ForSender(transceiver);

    expect(setCodecPreferences).toHaveBeenCalledTimes(1);
    // 两个 H264（大小写不同都算）在前，VP8/VP9 保持原相对顺序
    expect(setCodecPreferences.mock.calls[0]![0]).toEqual([
      { mimeType: 'video/H264' },
      { mimeType: 'video/h264' },
      { mimeType: 'video/VP8' },
      { mimeType: 'video/VP9' },
    ]);
  });

  it('无 H.264 能力时不调用 setCodecPreferences（保持浏览器默认 VP8/VP9）', () => {
    stubCodecCapabilities([{ mimeType: 'video/VP8' }, { mimeType: 'video/VP9' }]);

    const { transceiver, setCodecPreferences } = fakeTransceiver();
    preferH264ForSender(transceiver);
    expect(setCodecPreferences).not.toHaveBeenCalled();
  });

  it('getCapabilities 返回 null 或抛错时静默忽略（不中断共享）', () => {
    stubCodecCapabilities(null);
    const a = fakeTransceiver();
    expect(() => preferH264ForSender(a.transceiver)).not.toThrow();
    expect(a.setCodecPreferences).not.toHaveBeenCalled();

    stubCodecCapabilities('throw');
    const b = fakeTransceiver();
    expect(() => preferH264ForSender(b.transceiver)).not.toThrow();
    expect(b.setCodecPreferences).not.toHaveBeenCalled();
  });
});

describe('applyShareQualityToSender', () => {
  it('写入当前档位的码率与分辨率缩放', () => {
    const preset = SHARE_QUALITY_PRESETS['1080p60'];
    const { sender, params } = fakeSender();

    applyShareQualityToSender(sender, '1080p60', false);

    expect(params.encodings![0]!.maxBitrate).toBe(preset.maxBitrate);
    expect(params.encodings![0]!.scaleResolutionDownBy).toBe(preset.scale);
  });

  it('不设置 minBitrate（BWE 对屏幕共享是内容自适应，设了反而浪费上行）', () => {
    const { sender, params } = fakeSender();
    applyShareQualityToSender(sender, '720p30', false);
    expect('minBitrate' in params.encodings![0]!).toBe(false);
  });

  it('降级偏好：普通模式用档位预设，清晰文字模式固定 maintain-resolution', () => {
    const normal = fakeSender();
    applyShareQualityToSender(normal.sender, '1080p60', false);
    expect((normal.params as { degradationPreference?: string }).degradationPreference).toBe(
      SHARE_QUALITY_PRESETS['1080p60'].degradation
    );

    const sharp = fakeSender();
    applyShareQualityToSender(sharp.sender, '1080p60', true);
    expect((sharp.params as { degradationPreference?: string }).degradationPreference).toBe(
      'maintain-resolution'
    );
  });

  it('encodings 缺失或为空时补一个空对象再写参数', () => {
    const missing = fakeSender();
    applyShareQualityToSender(missing.sender, '720p30', false);
    expect(missing.params.encodings).toHaveLength(1);

    const empty = fakeSender({ encodings: [] });
    applyShareQualityToSender(empty.sender, '720p30', false);
    expect(empty.params.encodings).toHaveLength(1);
    expect(empty.params.encodings![0]!.maxBitrate).toBe(SHARE_QUALITY_PRESETS['720p30'].maxBitrate);
  });

  it('setParameters 拒绝时不冒泡（浏览器不支持该参数则退回默认编码）', () => {
    const setParameters = vi.fn(() => Promise.reject(new Error('unsupported')));
    const sender = { getParameters: () => ({}), setParameters } as unknown as RTCRtpSender;
    expect(() => applyShareQualityToSender(sender, '720p30', false)).not.toThrow();
  });

  it('getParameters 抛错时静默忽略', () => {
    const sender = {
      getParameters: () => {
        throw new Error('closed');
      },
      setParameters: vi.fn(),
    } as unknown as RTCRtpSender;
    expect(() => applyShareQualityToSender(sender, '720p30', false)).not.toThrow();
  });
});

describe('applyShareQualityToSenders', () => {
  let first: ReturnType<typeof fakeSender>;
  let second: ReturnType<typeof fakeSender>;

  beforeEach(() => {
    first = fakeSender();
    second = fakeSender();
  });

  it('对全部 sender 生效，并跳过空洞（对端未挂共享轨道时为 undefined）', () => {
    applyShareQualityToSenders([null, first.sender, undefined, second.sender], '720p30', false);
    expect(first.setParameters).toHaveBeenCalledTimes(1);
    expect(second.setParameters).toHaveBeenCalledTimes(1);
    expect(first.params.encodings![0]!.maxBitrate).toBe(SHARE_QUALITY_PRESETS['720p30'].maxBitrate);
  });

  it('空集合不报错', () => {
    expect(() => applyShareQualityToSenders([], '1080p60', false)).not.toThrow();
  });
});
