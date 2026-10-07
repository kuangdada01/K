/**
 * ============================================================
 * 语音偏好持久化（voice/prefs）
 * ============================================================
 * 自 VoiceSession.ts 拆出（行为不变）：localStorage 键名与
 * 读写辅助（数字/布尔开关）。VoiceSession 保留 re-export 兼容既有导入。
 */

/** 麦克风音量偏好键（0-100%） */
export const MIC_VOLUME_KEY = 'voice:micVolume';
/** 麦克风降噪开关偏好键（默认关；刷新/重新进房后保持） */
export const NOISE_REDUCTION_KEY = 'voice:noiseReduction';
/** 音乐模式开关偏好键（默认关：高码率立体声 + 关闭回声消除/降噪处理链） */
export const MUSIC_MODE_KEY = 'voice:musicMode';
/** 单人音量偏好键（按 自己:对端 维度） */
export const peerVolumeKey = (selfId: number, peerId: number) => `voice:vol:${selfId}:${peerId}`;

/** 读取数值偏好（非法/缺省回退 fallback） */
export function loadNumber(key: string, fallback: number): number {
  const v = parseFloat(localStorage.getItem(key) ?? '');
  return Number.isFinite(v) ? v : fallback;
}

/** 读取 '1'/'0' 开关偏好（缺省 false） */
export function loadFlag(key: string): boolean {
  return localStorage.getItem(key) === '1';
}
