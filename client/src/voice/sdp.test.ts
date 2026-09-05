/**
 * SDP 加工工具测试（voice/sdp）
 * applyOpusPreferences：fmtp 追加、无 fmtp 行时插入、音乐/语音双模式、多 opus m 段
 */
import { describe, it, expect } from 'vitest';
import { applyOpusPreferences } from './sdp';

/** 最小可协商 SDP：一条 opus m 段（有 fmtp 行）+ 一条非 opus m 段 */
const BASE_SDP = [
  'v=0',
  'o=- 1 1 IN IP4 0.0.0.0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 0',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10',
  'a=rtpmap:0 PCMU/8000',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'a=rtpmap:96 VP8/90000',
].join('\r\n');

/** 无 fmtp 行的 opus m 段（部分浏览器能力协商后不产 fmtp） */
const NO_FMTP_SDP = [
  'v=0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'a=rtpmap:111 opus/48000/2',
].join('\r\n');

describe('applyOpusPreferences', () => {
  it('语音模式：在既有 fmtp 上追加 fec/dtx/64k，保留原有参数', () => {
    const out = applyOpusPreferences(BASE_SDP, false);
    const fmtp = out.split('\r\n').find(l => l.startsWith('a=fmtp:111 '))!;
    expect(fmtp).toContain('minptime=10');
    expect(fmtp).toContain('useinbandfec=1');
    expect(fmtp).toContain('usedtx=0');
    expect(fmtp).toContain('maxaveragebitrate=64000');
    expect(fmtp).not.toContain('stereo=1');
  });

  it('音乐模式：96k 立体声档', () => {
    const out = applyOpusPreferences(BASE_SDP, true);
    const fmtp = out.split('\r\n').find(l => l.startsWith('a=fmtp:111 '))!;
    expect(fmtp).toContain('maxaveragebitrate=96000');
    expect(fmtp).toContain('stereo=1');
  });

  it('无 fmtp 行时在 rtpmap 之后插入一条', () => {
    const out = applyOpusPreferences(NO_FMTP_SDP, false);
    const lines = out.split('\r\n');
    const rtpIdx = lines.findIndex(l => l.startsWith('a=rtpmap:111'));
    expect(lines[rtpIdx + 1]).toMatch(/^a=fmtp:111 .*useinbandfec=1/);
  });

  it('重复调用幂等：不叠加参数（旧值被替换）', () => {
    const once = applyOpusPreferences(BASE_SDP, false);
    const twice = applyOpusPreferences(once, false);
    expect(twice.match(/useinbandfec=1/g)?.length).toBe(1);
  });

  it('麦克风 + 共享系统声音两条 opus m 段都被处理', () => {
    const dual = BASE_SDP.replace('m=video 9 UDP/TLS/RTP/SAVPF 96', 'm=audio 9 UDP/TLS/RTP/SAVPF 112')
      + '\r\na=rtpmap:112 opus/48000/2';
    const out = applyOpusPreferences(dual, false);
    expect(out.match(/useinbandfec=1/g)?.length).toBe(2);
  });

  it('无 opus 的 SDP 原样返回', () => {
    const noOpus = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 0\r\na=rtpmap:0 PCMU/8000';
    expect(applyOpusPreferences(noOpus, false)).toBe(noOpus);
  });
});
