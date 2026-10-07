/**
 * ============================================================
 * 音乐播放引擎（music/MusicEngine）
 * ============================================================
 * 自 MusicContext.tsx 拆出（§3.4，行为逐行不变）：
 * - 持有共享 <audio> 元素（create/preload/volume/卸载清理）
 * - 播放列表与游标（currentIndex/currentSong）
 * - 播放状态与时长（ended 自切歌、loadedmetadata 上报时长）
 * - 指令式控制：play/pause/next/prev/seek/playSong/setSongs
 *
 * 状态变化经 MusicEngineCallbacks 上报（React 层桥接为 state）；
 * §5.2 修复已内置：src 命中当前曲目时同样调用 play()
 * （playSong(当前曲目) 只置 isPlaying 不发声的缺陷）。
 * ============================================================
 */

export interface MusicSong {
  title: string;
  artist: string;
  src: string;
}

export interface MusicEngineCallbacks {
  onIndexChange(index: number): void;
  onPlayingChange(playing: boolean): void;
  onDurationChange(duration: number): void;
  onSongsChange(songs: MusicSong[]): void;
}

export class MusicEngine {
  private audio: HTMLAudioElement | null = null;
  private index = 0;
  private playing = false;
  private songs: MusicSong[] = [];
  private disposed = false;

  constructor(private cb: MusicEngineCallbacks) {}

  /** 挂载时初始化共享 <audio> 元素并接线（ended 自切歌 / loadedmetadata 上报时长） */
  init(): void {
    if (this.audio || this.disposed) return;
    const audio = new Audio();
    audio.preload = 'auto';
    audio.volume = 0.5;
    this.audio = audio;
    audio.addEventListener('ended', this.onEnded);
    audio.addEventListener('loadedmetadata', this.onLoadedMetadata);
  }

  /** 卸载清理：摘监听、暂停、清 src */
  dispose(): void {
    this.disposed = true;
    const audio = this.audio;
    if (!audio) return;
    audio.removeEventListener('ended', this.onEnded);
    audio.removeEventListener('loadedmetadata', this.onLoadedMetadata);
    audio.pause();
    audio.src = '';
    this.audio = null;
  }

  private onEnded = () => {
    this.next();
  };

  private onLoadedMetadata = () => {
    if (this.audio) this.cb.onDurationChange(this.audio.duration);
  };

  private currentSong(): MusicSong | null {
    return this.songs[this.index] ?? null;
  }

  /** src 接线 + 播放（原 React effect 语义：src 不匹配才重设并 load；
   *  src 命中当前曲目时直接 play——§5.2 修复 playSong(当前曲目) 无声） */
  private syncSrcAndPlay(): void {
    if (!this.audio) return;
    const song = this.currentSong();
    if (!song) return;
    const audio = this.audio;
    // 相对路径时 audio.src 会解析为绝对地址，两种情况都需匹配
    const isCurrent = audio.src === song.src || audio.src === window.location.origin + song.src;
    if (!isCurrent) {
      audio.src = song.src;
      audio.load();
    }
    if (this.playing) {
      audio.play().catch(() => {});
    }
  }

  /** 更新播放列表（拉取成功后由上下文注入；游标不动） */
  setSongs(songs: MusicSong[]): void {
    this.songs = songs;
    this.cb.onSongsChange(songs);
  }

  play(): void {
    if (!this.audio || !this.currentSong()) return;
    this.audio.play().catch(() => {});
    this.setPlaying(true);
    this.syncSrcAndPlay();
  }

  pause(): void {
    this.audio?.pause();
    this.setPlaying(false);
  }

  /** 下一首（列表空则回 0；播完自动切歌同路径） */
  next(): void {
    const len = this.songs.length;
    this.index = len > 0 ? (this.index + 1) % len : 0;
    this.cb.onIndexChange(this.index);
    this.setPlaying(true);
    this.syncSrcAndPlay();
  }

  /** 上一首（列表空则回 0） */
  prev(): void {
    const len = this.songs.length;
    this.index = len > 0 ? (this.index - 1 + len) % len : 0;
    this.cb.onIndexChange(this.index);
    this.setPlaying(true);
    this.syncSrcAndPlay();
  }

  /** 跳转到指定时间（进度环等高频 UI 本地订阅 timeupdate，不经过 React state） */
  seek(time: number): void {
    if (!this.audio) return;
    this.audio.currentTime = time;
  }

  /** 播放指定曲目（含"播放当前曲目"——src 命中时同样发声，§5.2） */
  playSong(index: number): void {
    this.index = index;
    this.cb.onIndexChange(index);
    this.setPlaying(true);
    this.syncSrcAndPlay();
  }

  /** 读取共享 <audio> 元素（进度环等高频 UI 在本地订阅 timeupdate，不经过 React state）P6 */
  getAudioElement(): HTMLAudioElement | null {
    return this.audio;
  }

  private setPlaying(playing: boolean): void {
    this.playing = playing;
    this.cb.onPlayingChange(playing);
  }
}
