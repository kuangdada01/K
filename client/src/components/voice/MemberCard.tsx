/**
 * ============================================================
 * 语音房间成员卡片（components/voice/MemberCard）
 * ============================================================
 * 自 VoicePage.tsx 拆出（§3.2，行为不变）：头像 + 说话光环 + 静音标识 +
 * 右上角网络质量点 + 单人音量条（非本人显示）。
 * 样式复用 VoicePage.module.css（与拆分前同一份 CSS，视觉零变化）。
 *
 * P2-7：用 `memo` 包一层 —— 说话状态是每几百毫秒就可能翻转的高频状态
 * （`speaking` Set 变化会让整个成员网格重渲染），此前任何一个人说话，
 * **所有**成员卡都跟着重渲染一遍（含每张卡里的音量滑条）。
 * 生效前提是父组件传下来的 `onVolume` / `getVolume` 引用稳定，
 * 以及 `participant` 对象在两次 participants 推送之间不变（见 VoiceRoomView）。
 * ============================================================
 */

import { memo, useState } from 'react';
import { Headphones, MicOff, MonitorUp, Volume2 } from 'lucide-react';
import Avatar from '../ui/Avatar';
import VolumeSlider from '../ui/VolumeSlider';
import type { VoiceParticipant } from '../../types';
import type { VoiceQualityLevel } from '../../voice/VoiceSession';
import styles from '../../pages/VoicePage.module.css';

function MemberCard({
  participant,
  speaking,
  isSelf,
  quality,
  onVolume,
  getVolume,
}: {
  participant: VoiceParticipant;
  speaking: boolean;
  isSelf: boolean;
  quality: VoiceQualityLevel;
  onVolume: (userId: number, v: number) => void;
  getVolume: (userId: number) => number;
}) {
  const [volume, setVolume] = useState(() => Math.min(1, getVolume(participant.userId)));
  const qualityLabel = quality === 'good' ? '良好' : quality === 'fair' ? '不良' : '差';

  return (
    <div className={`${styles.memberCard} ${speaking ? styles.speaking : ''}`}>
      <span
        className={`${styles.qDot} ${styles[`q_${quality}`] ?? ''}`}
        title={`网络质量：${qualityLabel}`}
      />
      <div className={styles.avatarWrap}>
        <Avatar src={participant.avatar} username={participant.username} size={64} />
        {participant.muted && (
          <span className={styles.mutedBadge} title={participant.listener ? '仅收听' : '麦克风已关闭'}>
            {participant.listener ? <Headphones size={13} /> : <MicOff size={13} />}
          </span>
        )}
        {participant.sharing && (
          <span className={styles.sharingBadge} title="正在共享屏幕">
            <MonitorUp size={13} />
          </span>
        )}
      </div>
      <div className={styles.memberName}>
        {participant.username}
        {isSelf ? '（我）' : ''}
      </div>
      {!isSelf && (
        <div className={styles.peerVolume}>
          <Volume2 size={13} />
          <VolumeSlider
            value={volume}
            onChange={(v) => {
              setVolume(v);
              onVolume(participant.userId, v);
            }}
          />
        </div>
      )}
    </div>
  );
}

export default memo(MemberCard);
