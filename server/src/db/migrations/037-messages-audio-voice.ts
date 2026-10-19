import { addColumnIfMissing } from './helpers';
import type { Migration } from './helpers';

const migration: Migration = {
  id: 37,
  name: 'messages.audio_voice',
  up: (db) => {
    // 私信语音消息（2026-10-19）。
    //  · audio_url：uploads_private 里的文件名（不经静态服务，走 /api/messages/:id/media 鉴权下发）；
    //  · audio_duration_ms：时长，UI 画「0:07」与决定气泡宽度；
    //  · audio_waveform：JSON 数组字符串（0–100 的振幅，约 32 根），客户端画波形；
    //  · audio_text：ASR 转写缓存（点过「转文字」才写，避免每次播放都花一次上游额度）。
    // 与 image_url **互斥**：一条消息要么图片、要么语音（发送服务端会拒绝同时带两个）。
    addColumnIfMissing(db, 'messages', 'audio_url', 'audio_url TEXT');
    addColumnIfMissing(db, 'messages', 'audio_duration_ms', 'audio_duration_ms INTEGER DEFAULT 0');
    addColumnIfMissing(db, 'messages', 'audio_waveform', 'audio_waveform TEXT');
    addColumnIfMissing(db, 'messages', 'audio_text', 'audio_text TEXT');
  },
};

export default migration;
