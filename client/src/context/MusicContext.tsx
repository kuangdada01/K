import {
  createContext,
  useContext,
  useRef,
  useState,
  useEffect,
  ReactNode,
  useCallback,
  useMemo,
} from 'react';
import { getApiBaseUrl, resolveMediaUrl } from '../config';
import { events } from '../state/events';

interface Song {
  title: string;
  artist: string;
  src: string;
}

interface MusicContextType {
  currentSong: Song | null;
  isPlaying: boolean;
  currentIndex: number;
  duration: number;
  songs: Song[];
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
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [songs, setSongs] = useState<Song[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchSongs = useCallback(async () => {
    try {
      // 初始 loading 由 useState(true) 承担；刷新时不再同步置 loading，
      // 避免 effect 内同步 setState（react-hooks/set-state-in-effect）
      // 原生平台必须使用完整服务器地址（相对路径会解析到 WebView 本地 localhost）
      const res = await fetch(`${getApiBaseUrl()}/music`);
      if (res.ok) {
        const data = await res.json();
        setSongs(data.map((s: Song) => ({ ...s, src: resolveMediaUrl(s.src) || s.src })));
      }
    } catch (err) {
      console.error('Failed to fetch music list:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  // 用 ref 保存最新回调，避免 audio 事件监听器捕获首渲染的陈旧闭包
  // （ref 写入放在 effect 中，渲染期写 ref 会被 react-hooks/refs 拦截）
  const songsRef = useRef(songs);
  useEffect(() => {
    songsRef.current = songs;
  }, [songs]);
  const nextRef = useRef<() => void>(() => {});
  useEffect(() => {
    nextRef.current = () => {
      const len = songsRef.current.length;
      setCurrentIndex((prev) => (len > 0 ? (prev + 1) % len : 0));
      setIsPlaying(true);
    };
  });

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

  const pauseRef = useRef<() => void>(() => {});
  const playRef = useRef<() => void>(() => {});
  useEffect(() => {
    const onPause = () => {
      if (isPlayingRef.current) {
        pausedByEventRef.current = true;
        pauseRef.current();
      }
    };
    const onResume = () => {
      if (pausedByEventRef.current) {
        pausedByEventRef.current = false;
        if (!isPlayingRef.current && currentSong) {
          playRef.current();
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

  useEffect(() => {
    audioRef.current = new Audio();
    audioRef.current.preload = 'auto';
    audioRef.current.volume = 0.5;
    const audio = audioRef.current;
    const onEnded = () => nextRef.current();
    const onLoadedMetadata = () => {
      setDuration(audio.duration);
    };
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    return () => {
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.pause();
      audio.src = '';
    };
  }, []);

  useEffect(() => {
    if (!audioRef.current || !currentSong) return;
    const audio = audioRef.current;
    // 相对路径时 audio.src 会解析为绝对地址，两种情况都需匹配
    const isCurrent = audio.src === currentSong.src || audio.src === window.location.origin + currentSong.src;
    if (!isCurrent) {
      audio.src = currentSong.src;
      audio.load();
      if (isPlaying) {
        audio.play().catch(() => {});
      }
    }
  }, [currentIndex, currentSong, isPlaying]);

  const play = useCallback(() => {
    if (!audioRef.current || !currentSong) return;
    audioRef.current.play().catch(() => {});
    setIsPlaying(true);
  }, [currentSong]);

  const pause = useCallback(() => {
    if (!audioRef.current) return;
    audioRef.current.pause();
    setIsPlaying(false);
  }, []);

  // 通过 effect 同步最新 pause/play 到 ref（渲染期写 ref 会被 react-hooks/refs 拦截）
  useEffect(() => {
    pauseRef.current = pause;
    playRef.current = play;
  }, [pause, play]);

  const togglePlay = useCallback(() => {
    if (isPlaying) pause();
    else play();
  }, [isPlaying, pause, play]);

  const next = useCallback(() => {
    const len = songs.length;
    setCurrentIndex((prev) => (len > 0 ? (prev + 1) % len : 0));
    setIsPlaying(true);
  }, [songs.length]);

  const prev = useCallback(() => {
    const len = songs.length;
    setCurrentIndex((prev) => (len > 0 ? (prev - 1 + len) % len : 0));
    setIsPlaying(true);
  }, [songs.length]);

  // P6：seek 不再更新 context currentTime；进度条组件本地维护，指令式跳转即可
  const seek = useCallback((time: number) => {
    if (!audioRef.current) return;
    audioRef.current.currentTime = time;
  }, []);

  const playSong = useCallback((index: number) => {
    setCurrentIndex(index);
    setIsPlaying(true);
  }, []);

  const getAudioElement = useCallback(() => audioRef.current, []);

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
