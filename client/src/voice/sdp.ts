/**
 * ============================================================
 * SDP 加工工具（voice/sdp）
 * ============================================================
 * Opus 抗丢包/音质调优：本地 SDP 的 fmtp 追加
 * 语音模式：useinbandfec=1（带内 FEC：弱网丢包时显著减少电流/机器声）、
 *   usedtx=0（不启用不连续传输，保持声音连续性）、
 *   maxaveragebitrate=64000（人声 48k+ 已接近透明的甜点；mesh 架构下带宽 ×(N-1)，
 *   再高人声无感、弱网先崩）。
 * 音乐模式：maxaveragebitrate=96000 + stereo=1（Opus 高保真档：音乐瞬态与立体声
 *   声像不再被 32k 单声道糊掉；配合采集端关闭 AEC/AGC/NS 的原始声）。
 * fmtp 描述的是本端编码器行为，只写本地描述即可；对端部署同版本后其编码器同样生效。
 */

export function applyOpusPreferences(sdp: string, musicMode: boolean): string {
  if (!sdp) return sdp;
  const lines = sdp.split(/\r?\n/);
  const extra = musicMode
    ? 'useinbandfec=1;usedtx=0;maxaveragebitrate=96000;stereo=1'
    : 'useinbandfec=1;usedtx=0;maxaveragebitrate=64000';
  // 收集所有 opus rtpmap 的 payload type（麦克风 + 屏幕共享系统声音各一条 m 段）
  const opusPayloads: string[] = [];
  for (const line of lines) {
    const m = line.match(/^a=rtpmap:(\d+)\s+opus\/48000/i);
    if (m && !opusPayloads.includes(m[1])) opusPayloads.push(m[1]);
  }
  if (opusPayloads.length === 0) return sdp;
  // 对每条 opus 的 fmtp 追加参数；无 fmtp 行的插到其 rtpmap 之后
  for (let i = 0; i < lines.length; i++) {
    const rtp = lines[i].match(/^a=rtpmap:(\d+)\s+opus\/48000/i);
    if (!rtp || !opusPayloads.includes(rtp[1])) continue;
    const payload = rtp[1];
    const fmtpIdx = lines.findIndex((l, j) => j > i && l.startsWith(`a=fmtp:${payload} `));
    if (fmtpIdx >= 0) {
      const prefix = `a=fmtp:${payload} `;
      const kept = lines[fmtpIdx]
        .slice(prefix.length)
        .split(';')
        .map((p) => p.trim())
        .filter((p) => p && !/^(useinbandfec|usedtx|maxaveragebitrate|stereo)=/i.test(p));
      lines[fmtpIdx] = `${prefix}${[...kept, extra].join(';')}`;
    } else {
      lines.splice(i + 1, 0, `a=fmtp:${payload} ${extra}`);
    }
  }
  return lines.join('\r\n');
}
