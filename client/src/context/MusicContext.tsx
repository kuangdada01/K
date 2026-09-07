import { createContext, useContext, useRef, useState, useEffect, useCallback, useMemo } from 'react';
import type { ReactNode } from 'react';
import { getApiBaseUrl, resolveMediaUrl } from '../config';
import { events } from '../state/events';
import { MusicEngine } from '../music/MusicEngine';
import type { MusicSong } from '../music/MusicEngine';

interface MusicContextType {
  currentSong: MusicSong | null;
  isPlaying: boolean;
  currentIndex: number;
  duration: number;
  songs: MusicSong[];
  loading: boolean;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  next: () => void;
  prev: () => void;
  seek: (time: number) => void;
  playSong: (index: number) => void;
  refreshSongs: () => void;
  /** 读取共享 <audio> 元素（进度环等高频 UI 在本地订阅 timeupdate，不经过 React state）P6 */
  getAudioElement: () => HTMLAudioElement | null;
}

const MusicContext = createContext<MusicContextType | null>(null);

export function MusicProvider({ children }: { children: ReactNode }) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [songs, setSongs] = useState<MusicSong[]>([]);
  const [loading, setLoading] = useState(true);

  // 播放引擎（audio 生命周期/播放列表/ended 自切歌，见 ../music/MusicEngine.ts）。
  // 惰性创建一次：callbacks 只做 state 桥接（setState 函数稳定），init/dispose
  // 由挂载 effect 负责（与拆分前 audio 元素创建/清理同一时机）。
  const engineRef = useRef<MusicEngine | null>(null);
  if (engineRef.current == null) {
    engineRef.current = new MusicEngine({
      onIndexChange: setCurrentIndex,
      onPlayingChange: setIsPlaying,
      onDurationChange: setDuration,
      onSongsChange: setSongs,
    });
  }
  useEffect(() => {
    engineRef.current!.init();
    return () => engineRef.current!.dispose();
  }, []);

  const fetchSongs = useCallback(async () => {
    try {
      // 初始 loading 由 useState(true) 承担；刷新时不再同步置 loading，
      // 避免 effect 内同步 setState（react-hooks/set-state-in-effect）
      // 原生平台必须使用完整服务器地址（相对路径会解析到 WebView 本地 localhost）
      const res = await fetch(`${getApiBaseUrl()}/music`);
      if (res.ok) {
        const data = await res.json();
        engineRef.current!.setSongs(
          data.map((s: MusicSong) => ({ ...s, src: resolveMediaUrl(s.src) || s.src }))
        );
      }
    } catch (err) {
      console.error('Failed to fetch music list:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // 挂载时拉取：经 Promise 回调间接调用（effect 同步路径不直接调用含 setState 的函数）
    void Promise.resolve().then(() => fetchSongs());
  }, [fetchSongs]);
  const currentSong = songs[currentIndex] || null;

  // P6：暂停/恢复音乐改走事件总线（PostDetail 开视频时发 music:pause / 关闭时 music:resume），
  // 不再让 PostDetail 整包消费 MusicContext。isPlaying 用 ref 读取避免触发重渲染。
  const isPlayingRef = useRef(isPlaying);
  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);
  // 仅当暂停确实由 music:pause 事件触发时，music:resume 才恢复播放
  // （用户手动暂停后打开/关闭视频不应误恢复音乐）
  const pausedByEventRef = useRef(false);

  useEffect(() => {
    const onPause = () => {
      if (isPlayingRef.current) {
        pausedByEventRef.current = true;
        engineRef.current?.pause();
      }
    };
    const onResume = () => {
      if (pausedByEventRef.current) {
        pausedByEventRef.current = false;
        if (!isPlayingRef.current && currentSong) {
          engineRef.current?.play();
        }
      }
    };
    events.on('music:pause', onPause);
    events.on('music:resume', onResume);
    return () => {
      events.off('music:pause', onPause);
      events.off('music:resume', onResume);
    };
  }, [currentSong]);

  const play = useCallback(() => engineRef.current?.play(), []);
  const pause = useCallback(() => engineRef.current?.pause(), []);

  const togglePlay = useCallback(() => {
    if (isPlaying) pause();
    else play();
  }, [isPlaying, pause, play]);

  const next = useCallback(() => engineRef.current?.next(), []);
  const prev = useCallback(() => engineRef.current?.prev(), []);

  // P6：seek 不再更新 context currentTime；进度条组件本地维护，指令式跳转即可
  const seek = useCallback((time: number) => engineRef.current?.seek(time), []);

  const playSong = useCallback((index: number) => engineRef.current?.playSong(index), []);

  const getAudioElement = useCallback(() => engineRef.current?.getAudioElement() ?? null, []);

  const value = useMemo<MusicContextType>(
    () => ({
      currentSong,
      isPlaying,
      currentIndex,
      duration,
      songs,
      loading,
      play,
      pause,
      togglePlay,
      next,
      prev,
      seek,
      playSong,
      refreshSongs: fetchSongs,
      getAudioElement,
    }),
    [
      currentSong,
      isPlaying,
      currentIndex,
      duration,
      songs,
      loading,
      play,
      pause,
      togglePlay,
      next,
      prev,
      seek,
      playSong,
      fetchSongs,
      getAudioElement,
    ]
  );

  return <MusicContext.Provider value={value}>{children}</MusicContext.Provider>;
}

export function useMusic() {
  const ctx = useContext(MusicContext);
  if (!ctx) throw new Error('useMusic must be used within MusicProvider');
  return ctx;
}
