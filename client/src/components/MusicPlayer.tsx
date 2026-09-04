import { useEffect, useState } from 'react';
import { useMusic } from '../context/MusicContext';
import { Play, Pause, SkipBack, SkipForward } from 'lucide-react';
import '../styles/music-player.css';

const R = 15;
const C = 2 * Math.PI * R;

interface MusicPlayerProps {
  /** inline: 渲染在右侧栏推荐关注下方（桌面）；默认右下角浮窗（移动） */
  inline?: boolean;
}

export default function MusicPlayer({ inline = false }: MusicPlayerProps) {
  const { currentSong, isPlaying, duration, togglePlay, next, prev, getAudioElement } = useMusic();
  // P6 修复：进度环不再依赖 context 的 currentTime（那会让 PostDetail 每秒多次重渲染），
  // 改为本地订阅共享 <audio> 的 timeupdate（低频 state，仅影响本组件进度环）。
  const [currentTime, setCurrentTime] = useState(0);

  useEffect(() => {
    if (!isPlaying) return;
    const audio = getAudioElement();
    if (!audio) return;
    const onTime = () => setCurrentTime(audio.currentTime);
    const onMeta = () => setCurrentTime(0);
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('loadedmetadata', onMeta);
    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('loadedmetadata', onMeta);
    };
  }, [isPlaying, currentSong?.src, getAudioElement]);

  const progress = duration > 0 ? (currentTime / duration) : 0;

  if (!currentSong) return null;

  return (
    <div className={inline ? 'music-player music-player-inline' : 'music-player'}>
      <div className="music-player-info">
        <span className="music-player-title">{currentSong.title}</span>
        <span className="music-player-artist">{currentSong.artist}</span>
      </div>
      <div className="music-player-controls">
        <button className="music-player-btn" onClick={prev} title="上一首">
          <SkipBack size={16} />
        </button>
        <button className="music-player-btn music-player-play-btn" onClick={togglePlay} title={isPlaying ? '暂停' : '播放'}>
          {isPlaying && (
            <svg className="music-player-progress-ring" viewBox="0 0 34 34">
              <circle cx="17" cy="17" r={R} fill="none" strokeWidth="2"
                strokeLinecap="round"
                strokeDasharray={C}
                strokeDashoffset={C * (1 - progress)}
                transform="rotate(-90 17 17)" />
            </svg>
          )}
          {isPlaying ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <button className="music-player-btn" onClick={next} title="下一首">
          <SkipForward size={16} />
        </button>
      </div>
    </div>
  );
}