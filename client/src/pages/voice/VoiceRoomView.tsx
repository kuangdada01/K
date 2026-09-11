/**
 * ============================================================
 * 语音房间内视图（pages/voice/VoiceRoomView）
 * ============================================================
 * 自 VoicePage.tsx 拆出（§3.2，行为不变）：
 * - 头部（退出、房间名、人数/重连中）
 * - 屏幕共享舞台（有人共享时显示在成员网格上方）
 * - 参与者卡片网格（说话光环/静音/单人音量）
 * - 文字聊天面板（VoiceChatPanel，含朗读）
 * - 底部控制栏（麦克风/降噪/音乐模式/屏幕共享/录制计时/麦克风音量）
 *
 * rooms 由 VoicePage 编排层传入（进房期间仍 10s 轮询，当前房间的
 * isCreator 决定"清空聊天"权限，与拆分前同一数据源同一时刻）。
 * 样式复用 VoicePage.module.css（与拆分前同一份 CSS，视觉零变化）。
 * ============================================================
 */

import { useCallback, useEffect, useState } from 'react';
import { AudioWaveform, Circle, LogOut, Mic, MicOff, MonitorUp, Music, Volume2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useVoice, useVoiceRealtime } from '../../context/VoiceContext';
import VoiceShareStage from '../../components/VoiceShareStage';
import MemberCard from '../../components/voice/MemberCard';
import VolumeSlider from '../../components/ui/VolumeSlider';
import { isOwnedGuestRoom } from '../../voice/roomOwnership';
import VoiceChatPanel from './VoiceChatPanel';
import type { VoiceRoom } from '../../types';
import { VOICE_MAX_ROOM_SIZE } from '@k/shared';
import styles from '../VoicePage.module.css';

export default function VoiceRoomView({ rooms }: { rooms: VoiceRoom[] }) {
  const { user } = useAuth();
  const voice = useVoice();
  const realtime = useVoiceRealtime();

  // 滑条受控值（session 内部持久化，这里镜像以便渲染；进房时读 session 现值）
  const [micVolume, setMicVolume] = useState(() => voice.getMicVolume());
  // 录制已录秒数（interval 回调里由开始时间戳推算；开始新一轮录制时归零）
  const [recSeconds, setRecSeconds] = useState(0);

  const self = voice.participants[0];
  const isSharingSelf = !!voice.share && voice.share.userId === self?.userId;
  // 当前房间的创建者身份来自轮询的房间列表（登录用户比 creator_id；
  // 访客房间服务端不再按 IP 声称所有权，改由本地保存的令牌补齐 —— 游客/管理员同样可管理）
  const currentRoom = rooms.find((r) => r.id === voice.activeRoomId) ?? null;
  const canClearChat =
    currentRoom !== null &&
    (currentRoom.isCreator === true || user?.role === 'admin' || isOwnedGuestRoom(currentRoom.id));

  // 录制中每秒刷新已录时长（秒数只在 interval 回调里更新，避免渲染期读时钟）
  useEffect(() => {
    const startedAt = voice.recordingStartedAt;
    if (!voice.isRecording || !startedAt) return;
    const timer = window.setInterval(() => {
      setRecSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [voice.isRecording, voice.recordingStartedAt]);

  const handleToggleRecording = () => {
    if (!voice.isRecording) setRecSeconds(0);
    voice.toggleRecording();
  };

  const handleLeave = () => voice.leave();

  // 引用固定，否则 MemberCard 的 memo 会因「每次渲染都是新闭包」而完全失效（P2-7）。
  // 先取出控制器里那个稳定的 useCallback（依赖数组只放它，不整个 voice 对象）。
  const setPeerVolume = voice.setPeerVolume;
  const handlePeerVolume = useCallback(
    (userId: number, v: number) => setPeerVolume(userId, v),
    [setPeerVolume]
  );

  return (
    <div className={styles.page}>
      <div className={styles.roomHeader}>
        <button className={styles.backBtn} data-back onClick={handleLeave} title="退出房间">
          <LogOut size={18} style={{ transform: 'scaleX(-1)' }} />
        </button>
        <div className={styles.roomTitleWrap}>
          <h1 className={styles.roomTitle}>{voice.activeRoomName ?? '语音房间'}</h1>
          <span className={styles.roomCount}>
            {voice.status === 'reconnecting'
              ? '重连中…'
              : `${voice.participants.length}/${VOICE_MAX_ROOM_SIZE} 人在线`}
          </span>
        </div>
      </div>

      {/* 屏幕共享舞台（16:9，可全屏）：有人共享时显示在成员网格上方 */}
      {voice.share && <VoiceShareStage />}

      <div className={styles.memberGrid}>
        {voice.participants.map((p) => (
          <MemberCard
            key={p.userId}
            participant={p}
            speaking={realtime.speaking.has(p.userId)}
            isSelf={p.userId === self?.userId}
            quality={realtime.peerQuality[p.userId] ?? 'good'}
            onVolume={handlePeerVolume}
            getVolume={voice.getPeerVolume}
          />
        ))}
      </div>

      <VoiceChatPanel canClearChat={canClearChat} activeRoomId={voice.activeRoomId} />

      <div className={styles.controlBar}>
        <button
          className={`${styles.micBtn} ${self && !self.muted ? styles.micOn : styles.micOff}`}
          onClick={voice.toggleMute}
          disabled={self?.listener}
          title={self?.listener ? '未获得麦克风权限，仅收听' : self?.muted ? '打开麦克风' : '关闭麦克风'}
        >
          {self?.muted || self?.listener ? <MicOff size={16} /> : <Mic size={16} />}
          <span>{self?.listener ? '收听中' : self?.muted ? '已静音' : '麦克风开'}</span>
        </button>

        <button
          className={`${styles.noiseBtn} ${voice.noiseReduction ? styles.noiseOn : styles.noiseOff}`}
          onClick={voice.toggleNoiseReduction}
          disabled={voice.musicMode}
          title={
            voice.musicMode
              ? '音乐模式下处理链已关闭（降噪与音乐保真互斥）'
              : voice.noiseReduction
                ? '关闭降噪（恢复原声）'
                : '打开降噪：只保留人声，降低风扇/空调等环境声'
          }
        >
          <AudioWaveform size={16} />
          <span>{voice.noiseReduction ? '降噪开' : '降噪'}</span>
        </button>

        <button
          className={`${styles.noiseBtn} ${voice.musicMode ? styles.noiseOn : styles.noiseOff}`}
          onClick={voice.toggleMusicMode}
          title={
            voice.musicMode
              ? '关闭音乐模式（恢复语音优化档：降噪/回声消除/抗丢包冗余）'
              : '音乐模式：音质升为 96k 立体声，关闭回声消除与降噪（适合播放/演唱音乐，请佩戴耳机）'
          }
        >
          <Music size={16} />
          <span>{voice.musicMode ? '音乐开' : '音乐'}</span>
        </button>

        {voice.canScreenShare && (
          <button
            className={`${styles.shareBtn} ${isSharingSelf ? styles.shareOn : styles.shareOff}`}
            onClick={voice.toggleScreenShare}
            title={
              isSharingSelf
                ? '停止屏幕共享'
                : '共享屏幕给全房间（整屏共享受浏览器限制约 30-40fps；共享标签页/应用窗口可更流畅。观看者越多越占上传带宽）'
            }
          >
            <MonitorUp size={16} />
            <span>{isSharingSelf ? '停止共享' : '共享屏幕'}</span>
          </button>
        )}

        <button
          className={`${styles.recBtn} ${voice.isRecording ? styles.recActive : ''}`}
          onClick={handleToggleRecording}
          title={voice.isRecording ? '停止录制并下载 MP3' : '录制房间内所有声音'}
        >
          {voice.isRecording ? (
            <>
              <span className={styles.recDot} />
              <span className={styles.recTime}>
                {String(Math.floor(recSeconds / 60)).padStart(2, '0')}:
                {String(recSeconds % 60).padStart(2, '0')}
              </span>
            </>
          ) : (
            <>
              <Circle size={14} fill="currentColor" strokeWidth={0} />
              <span className={styles.recLabel}>录制</span>
            </>
          )}
        </button>

        <div className={styles.volumeGroup}>
          <Volume2 size={16} />
          <span className={styles.volumeLabel}>麦克风</span>
          <VolumeSlider
            value={micVolume}
            max={1}
            onChange={(v) => {
              setMicVolume(v);
              voice.setMicVolume(v);
            }}
          />
          <span className={styles.volumeValue}>{Math.round(micVolume * 100)}%</span>
        </div>
      </div>
    </div>
  );
}
