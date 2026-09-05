/**
 * ============================================================
 * 语音会话全局上下文 (VoiceContext)
 * ============================================================
 * 会话挂在应用根部而非 VoicePage 组件：
 * 切换页面不退出房间，仅在主动退出 / 关闭网页 / 登出时断开。
 *
 * 刷新页面：sessionStorage 记录活跃房间（关闭标签页即清除），
 * 应用加载后自动静默回到房间，配合 VoiceSession 的
 * "首次交互恢复音频" 兜底实现"关掉网址才真正断开"。
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from './AuthContext';
import { showToast } from '../components/ui/Toast';
import { VoiceSession, NOISE_REDUCTION_KEY, MUSIC_MODE_KEY } from '../voice/VoiceSession';
import type { VoiceStatus, VoiceQualityLevel, ShareQuality, ShareStats } from '../voice/VoiceSession';
import { getVoiceRoomMessages } from '../api/voice';
import type { VoiceChatMessage, VoiceParticipant } from '../types';

const ACTIVE_ROOM_KEY = 'voice:activeRoom';

/** 屏幕共享展示状态（userId=null 视为无共享；stream 就绪前舞台显示"正在接收画面"） */
export interface VoiceShareState {
  userId: number;
  stream: MediaStream | null;
  audio: boolean;
}

export interface VoiceContextValue {
  status: VoiceStatus;
  participants: VoiceParticipant[];
  /** 高频字段已移到 VoiceRealtimeContext，通过 useVoiceRealtime() 获取；此处保留类型标注保证 useVoice() 兼容字段读取（已废弃，请迁移） */
  speaking?: Set<number>;
  peerQuality?: Record<number, VoiceQualityLevel>;
  inRoom: boolean;
  activeRoomId: number | null;
  activeRoomName: string | null;
  join: (roomId: number, roomName?: string) => void;
  leave: () => void;
  toggleMute: () => void;
  /** 全房间录制：开 = 录远端各路 + 开麦时的自己；关 = 转码 MP3 自动下载 */
  toggleRecording: () => void;
  isRecording: boolean;
  recordingStartedAt: number | null;
  setMicVolume: (v: number) => void;
  setPeerVolume: (userId: number, v: number) => void;
  getPeerVolume: (userId: number) => number;
  getMicVolume: () => number;
  /** 麦克风降噪开关（默认关） */
  noiseReduction: boolean;
  toggleNoiseReduction: () => void;
  /** 音乐模式（默认关）：96k 立体声 + 关闭回声消除/降噪，播音乐/唱歌时开 */
  musicMode: boolean;
  toggleMusicMode: () => void;
  /** 屏幕共享（全房间唯一共享者，抢占式；null = 无人共享） */
  share: VoiceShareState | null;
  /** 发送端共享画面实时统计（帧率/码率/分辨率/降级原因；仅共享者端有数据）——已移到 useVoiceRealtime() */
  shareStats?: ShareStats | null;
  /** 浏览器是否支持屏幕捕获（不支持时 UI 隐藏入口） */
  canScreenShare: boolean;
  toggleScreenShare: () => void;
  shareQuality: ShareQuality;
  setShareQuality: (q: ShareQuality) => void;
  shareSharpText: boolean;
  toggleShareSharpText: () => void;
  /** 接收端共享声音开关（默认静音，符合自动播放策略） */
  shareMuted: boolean;
  toggleShareMuted: () => void;
  /** 文字聊天：消息按时间正序（末尾最新），持久化在服务端，房间删除时级联清理 */
  messages: VoiceChatMessage[];
  /** 是否还有更早的历史可向上翻页 */
  chatHasMore: boolean;
  /** 正在向上加载更早的聊天记录 */
  chatLoadingMore: boolean;
  /** 发送文字消息（走信令通道，与 WebRTC 语音媒体分离，语音差时文字仍可用）；返回是否成功发出 */
  sendChat: (content: string) => boolean;
  /** 向上翻页加载更早的聊天记录（自动按首条消息 id 定位） */
  loadMoreChat: () => void;
  /** 最近一条实时到达的聊天消息（仅 WS 实时广播触发，历史补拉不触发；用于"新消息朗读"等实时消费，null=暂无） */
  liveMessage: VoiceChatMessage | null;
}

// P5 拆包：高频状态（speaking / peerQuality / shareStats，每秒数次更新）单独放
// 一个 context，主 VoiceContext 内不再包含它们。这样只有使用 useVoiceRealtime()
// 的组件（语音页面/共享舞台）才会随连续说话状态重渲染，其余只是读 inRoom 的
// PostCard/Sidebar/CreatePost 不受影响。
const VoiceContext = createContext<VoiceContextValue | null>(null);
const VoiceRealtimeContext = createContext<{
  speaking: Set<number>;
  peerQuality: Record<number, VoiceQualityLevel>;
  shareStats: ShareStats | null;
} | null>(null);

export function VoiceProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [participants, setParticipants] = useState<VoiceParticipant[]>([]);
  const [speaking, setSpeaking] = useState<Set<number>>(new Set());
  const [peerQuality, setPeerQuality] = useState<Record<number, VoiceQualityLevel>>({});
  const [activeRoomId, setActiveRoomId] = useState<number | null>(null);
  const [activeRoomName, setActiveRoomName] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null);
  /** 麦克风降噪开关（默认关；偏好持久化在 localStorage，刷新后保持） */
  const [noiseReduction, setNoiseReduction] = useState<boolean>(
    () => localStorage.getItem(NOISE_REDUCTION_KEY) === '1'
  );
  /** 音乐模式（默认关；偏好持久化在 localStorage，刷新后保持） */
  const [musicMode, setMusicMode] = useState<boolean>(() => localStorage.getItem(MUSIC_MODE_KEY) === '1');
  // ---- 屏幕共享（userId 与 stream 分开存：状态广播先到、画面流随重协商后到） ----
  const [shareUserId, setShareUserId] = useState<number | null>(null);
  const [shareStream, setShareStream] = useState<MediaStream | null>(null);
  const [shareAudio, setShareAudio] = useState(false);
  const [shareQuality, setShareQualityState] = useState<ShareQuality>('1080p60');
  const [shareSharpText, setShareSharpTextState] = useState<boolean>(
    () => localStorage.getItem('voice:shareSharpText') === '1'
  );
  const [shareMuted, setShareMuted] = useState(true);
  const [shareStats, setShareStats] = useState<ShareStats | null>(null);
  // ---- 文字聊天（历史持久化在服务端，断线/重连后按 after_id 追赶补拉） ----
  const [messages, setMessages] = useState<VoiceChatMessage[]>([]);
  const [chatHasMore, setChatHasMore] = useState(false);
  const [chatLoadingMore, setChatLoadingMore] = useState(false);
  /** 最近一条实时到达的聊天消息（只保留最新；历史补拉不经过它） */
  const [liveMessage, setLiveMessage] = useState<VoiceChatMessage | null>(null);
  const sessionRef = useRef<VoiceSession | null>(null);
  const autoJoinTriedRef = useRef(false);
  /** 已见过（历史拉取或实时收到）的最大消息 id：重连/追补的游标 */
  const lastFetchedIdRef = useRef<number | null>(null);
  /** messages 的镜像 ref：翻页等回调读取首条 id 时避免把 messages 塞进依赖 */
  const messagesRef = useRef<VoiceChatMessage[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const share = useMemo<VoiceShareState | null>(
    () => (shareUserId === null ? null : { userId: shareUserId, stream: shareStream, audio: shareAudio }),
    [shareUserId, shareStream, shareAudio]
  );
  const canScreenShare = useMemo(
    () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia,
    []
  );

  const clearSavedRoom = useCallback(() => sessionStorage.removeItem(ACTIVE_ROOM_KEY), []);

  const resetState = useCallback(() => {
    setStatus('idle');
    setParticipants([]);
    setSpeaking(new Set());
    setPeerQuality({});
    setActiveRoomId(null);
    setActiveRoomName(null);
    setIsRecording(false);
    setRecordingStartedAt(null);
    setShareUserId(null);
    setShareStream(null);
    setShareAudio(false);
    setShareStats(null);
    setMessages([]);
    setChatHasMore(false);
    setChatLoadingMore(false);
    setLiveMessage(null);
    lastFetchedIdRef.current = null;
  }, []);

  const join = useCallback(
    (roomId: number, roomName?: string) => {
      if (sessionRef.current) return;
      // 记录活跃房间：刷新后自动回房；关闭标签页时 sessionStorage 一并销毁
      sessionStorage.setItem(ACTIVE_ROOM_KEY, JSON.stringify({ roomId, name: roomName ?? null }));
      setActiveRoomId(roomId);
      if (roomName) setActiveRoomName(roomName);

      const session = new VoiceSession(
        user
          ? { userId: user.id, username: user.username, avatar: user.avatar }
          : // 未登录访客：占位身份，真实负数 id 由服务端分配后经 joined.self 回传校正
            { userId: 0, username: '未登录', avatar: null },
        {
          onStatus: (s) => {
            setStatus(s);
            if (s === 'ended') clearSavedRoom();
          },
          onParticipants: (list) => setParticipants(list),
          onSpeaking: (userId, isSpeaking) => {
            setSpeaking((prev) => {
              const next = new Set(prev);
              if (isSpeaking) next.add(userId);
              else next.delete(userId);
              return next;
            });
          },
          onError: (message) => showToast(message),
          onClosed: (reason) => showToast(reason),
          onPeerQuality: (userId, level) =>
            setPeerQuality((prev) => {
              if (level === null) {
                // 成员离开/断线重连：删除残留的质量状态
                if (!(userId in prev)) return prev;
                const next = { ...prev };
                delete next[userId];
                return next;
              }
              return { ...prev, [userId]: level };
            }),
          onRecordingChange: (rec, at) => {
            setIsRecording(rec);
            setRecordingStartedAt(at);
          },
          onShareChanged: (info) => {
            setShareUserId(info.userId);
            setShareAudio(info.audio);
          },
          onShareVideo: (stream) => setShareStream(stream),
          onShareStats: (stats) => setShareStats(stats),
          onShareQualityChange: (q) => setShareQualityState(q),
          // 文字聊天：实时消息按 id 去重追加（防与服务端历史拉取竞态重复）
          onChatMessage: (message) => {
            setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
            if (lastFetchedIdRef.current === null || message.id > lastFetchedIdRef.current) {
              lastFetchedIdRef.current = message.id;
            }
            // 暴露最近一条实时消息（朗读新消息等实时消费；历史补拉不经过这里）
            setLiveMessage(message);
          },
          // 房间聊天被创建者/管理员清空：本地同步清空（游标保留，后续只追新）
          onChatCleared: () => {
            setMessages([]);
            setChatHasMore(false);
          },
        }
      );
      sessionRef.current = session;
      setShareQualityState(session.getShareQuality());
      setShareSharpTextState(session.getShareSharpText());
      setShareMuted(session.getShareMuted());
      session.join(roomId).catch(() => {
        session.leave();
        if (sessionRef.current === session) sessionRef.current = null;
        clearSavedRoom();
        resetState();
        showToast('无法启动语音，请检查浏览器是否支持麦克风');
      });
    },
    [user, clearSavedRoom, resetState]
  );

  const leave = useCallback(() => {
    sessionRef.current?.leave();
    sessionRef.current = null;
    clearSavedRoom();
    resetState();
  }, [clearSavedRoom, resetState]);

  // 登出/登录过期：断开语音
  useEffect(() => {
    if (!user && sessionRef.current) leave();
  }, [user, leave]);

  // 刷新后自动回房（只尝试一次，房间已删/失败会走 error 流程并清理记录）
  useEffect(() => {
    if (!user || sessionRef.current || autoJoinTriedRef.current) return;
    const saved = sessionStorage.getItem(ACTIVE_ROOM_KEY);
    if (!saved) return;
    autoJoinTriedRef.current = true;
    try {
      const parsed = JSON.parse(saved) as { roomId?: unknown; name?: unknown };
      if (typeof parsed.roomId === 'number') {
        const roomId = parsed.roomId;
        const name = typeof parsed.name === 'string' ? parsed.name : undefined;
        // 微任务延迟触发，避免 effect 内同步 setState
        queueMicrotask(() => join(roomId, name));
      }
    } catch {
      sessionStorage.removeItem(ACTIVE_ROOM_KEY);
    }
  }, [user, join]);

  /** 文字聊天历史：进入/重连成功时拉取。
   *  首次进房取最近 50 条；断线重连（status 重新变为 connected）按已见最大 id
   *  追赶补拉（after_id），实时消息与历史拉取之间按 id 去重，不重复不丢失。 */
  useEffect(() => {
    if (status !== 'connected' || !activeRoomId) return;
    let cancelled = false;
    const afterId = lastFetchedIdRef.current;
    getVoiceRoomMessages(activeRoomId, afterId === null ? { limit: 50 } : { afterId, limit: 100 })
      .then(({ messages: fetched, has_more }) => {
        if (cancelled) return;
        if (fetched.length > 0) {
          setMessages((prev) => {
            const seen = new Set(prev.map((m) => m.id));
            return [...prev, ...fetched.filter((m) => !seen.has(m.id))];
          });
          const maxId = Math.max(...fetched.map((m) => m.id));
          if (lastFetchedIdRef.current === null || maxId > lastFetchedIdRef.current) {
            lastFetchedIdRef.current = maxId;
          }
        }
        setChatHasMore(has_more);
      })
      .catch(() => {
        // 拉取失败静默：下次重连会再次追赶，实时消息不受影响
      });
    return () => {
      cancelled = true;
    };
  }, [status, activeRoomId]);

  const sendChat = useCallback((content: string): boolean => {
    return sessionRef.current?.sendChat(content) ?? false;
  }, []);

  const loadMoreChat = useCallback(() => {
    const roomId = activeRoomId;
    const first = messagesRef.current[0];
    if (chatLoadingMore || !chatHasMore || !roomId || !first) return;
    setChatLoadingMore(true);
    getVoiceRoomMessages(roomId, { beforeId: first.id, limit: 50 })
      .then(({ messages: older, has_more }) => {
        setMessages((prev) => {
          const seen = new Set(prev.map((m) => m.id));
          return [...older.filter((m) => !seen.has(m.id)), ...prev];
        });
        setChatHasMore(has_more);
      })
      .catch(() => {
        // 翻页失败静默：可再次点击重试
      })
      .finally(() => setChatLoadingMore(false));
  }, [activeRoomId, chatHasMore, chatLoadingMore]);

  const toggleMute = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    const self = participants[0];
    session.setMuted(!self?.muted);
  }, [participants]);

  const toggleRecording = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    if (session.isRecording()) {
      showToast('录制完成，正在生成 MP3…');
      session.stopRecording();
    } else if (!session.startRecording(activeRoomName ?? undefined)) {
      showToast('当前浏览器不支持录音');
    }
  }, [activeRoomName]);

  /** 麦克风降噪开关：实时切换（RNNoise worklet，worklet 不可用时回退浏览器 NS），偏好持久化 */
  const toggleNoiseReduction = useCallback(() => {
    const next = !noiseReduction;
    setNoiseReduction(next);
    localStorage.setItem(NOISE_REDUCTION_KEY, next ? '1' : '0');
    sessionRef.current?.setNoiseReduction(next);
  }, [noiseReduction]);

  /** 音乐模式：高码率立体声 + 关闭处理链（AEC/AGC/NS/RNNoise），偏好持久化。
   *  回声消除关闭后外放会把房间声音录回麦里产生回声，开启时提醒戴耳机 */
  const toggleMusicMode = useCallback(() => {
    const next = !musicMode;
    setMusicMode(next);
    localStorage.setItem(MUSIC_MODE_KEY, next ? '1' : '0');
    sessionRef.current?.setMusicMode(next);
    if (next) showToast('音乐模式：音质已升为高保真立体声，请佩戴耳机以避免回声');
  }, [musicMode]);

  // ---- 屏幕共享 ----
  const toggleScreenShare = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    if (session.isSharing()) {
      session.stopScreenShare();
      return;
    }
    session
      .startScreenShare()
      .then((result) => {
        if (result === 'unsupported') showToast('当前浏览器不支持屏幕共享');
        // 用户在选择器里取消：静默不打扰
      })
      .catch((e) => {
        showToast('屏幕共享启动失败：' + (e?.message ?? '未知错误'));
      });
  }, []);

  const setShareQuality = useCallback((q: ShareQuality) => {
    setShareQualityState(q);
    sessionRef.current?.setShareQuality(q);
  }, []);

  const toggleShareSharpText = useCallback(() => {
    setShareSharpTextState((prev) => {
      const next = !prev;
      sessionRef.current?.setShareSharpText(next);
      return next;
    });
  }, []);

  const toggleShareMuted = useCallback(() => {
    setShareMuted((prev) => {
      const next = !prev;
      sessionRef.current?.setShareMuted(next);
      return next;
    });
  }, []);

  const setMicVolume = useCallback((v: number) => sessionRef.current?.setMicVolume(v), []);
  const setPeerVolume = useCallback(
    (userId: number, v: number) => sessionRef.current?.setPeerVolume(userId, v),
    []
  );
  const getPeerVolume = useCallback((userId: number) => sessionRef.current?.getPeerVolume(userId) ?? 1, []);
  const getMicVolume = useCallback(() => sessionRef.current?.getMicVolume() ?? 1, []);

  // P5 修复：主值用 useMemo 稳定化（依赖列表体现真实变化），高频 speaking/peerQuality/shareStats
  // 拆到 VoiceRealtimeContext，避免整个订阅树随说话状态每秒多次重渲染。
  const voiceValue = useMemo<VoiceContextValue>(
    () => ({
      status,
      participants,
      inRoom: status === 'connecting' || status === 'connected' || status === 'reconnecting',
      activeRoomId,
      activeRoomName,
      join,
      leave,
      toggleMute,
      toggleRecording,
      isRecording,
      recordingStartedAt,
      setMicVolume,
      setPeerVolume,
      getPeerVolume,
      getMicVolume,
      noiseReduction,
      toggleNoiseReduction,
      musicMode,
      toggleMusicMode,
      share,
      canScreenShare,
      toggleScreenShare,
      shareQuality,
      setShareQuality,
      shareSharpText,
      toggleShareSharpText,
      shareMuted,
      toggleShareMuted,
      messages,
      chatHasMore,
      chatLoadingMore,
      sendChat,
      loadMoreChat,
      liveMessage,
    }),
    [
      status,
      participants,
      activeRoomId,
      activeRoomName,
      join,
      leave,
      toggleMute,
      toggleRecording,
      isRecording,
      recordingStartedAt,
      setMicVolume,
      setPeerVolume,
      getPeerVolume,
      getMicVolume,
      noiseReduction,
      toggleNoiseReduction,
      musicMode,
      toggleMusicMode,
      share,
      canScreenShare,
      toggleScreenShare,
      shareQuality,
      setShareQuality,
      shareSharpText,
      toggleShareSharpText,
      shareMuted,
      toggleShareMuted,
      messages,
      chatHasMore,
      chatLoadingMore,
      sendChat,
      loadMoreChat,
      liveMessage,
    ]
  );

  const realtimeValue = useMemo(
    () => ({ speaking, peerQuality, shareStats }),
    [speaking, peerQuality, shareStats]
  );

  return (
    <VoiceContext.Provider value={voiceValue}>
      <VoiceRealtimeContext.Provider value={realtimeValue}>{children}</VoiceRealtimeContext.Provider>
    </VoiceContext.Provider>
  );
}

export function useVoice(): VoiceContextValue {
  const ctx = useContext(VoiceContext);
  if (!ctx) throw new Error('useVoice 必须在 VoiceProvider 内使用');
  return ctx;
}

/** 只订阅实时高频状态（说话/网络质量/共享统计）。低频组件不应调用它。 */
export function useVoiceRealtime(): {
  speaking: Set<number>;
  peerQuality: Record<number, VoiceQualityLevel>;
  shareStats: ShareStats | null;
} {
  const realtime = useContext(VoiceRealtimeContext);
  if (!realtime) throw new Error('useVoiceRealtime 必须在 VoiceProvider 内使用');
  return realtime;
}

/** P5：仅读取 inRoom 的精确选择器，不随说话/网络质量等高频状态重渲染。 */
export function useVoiceInRoom(): boolean {
  const ctx = useContext(VoiceContext);
  if (!ctx) throw new Error('useVoiceInRoom 必须在 VoiceProvider 内使用');
  return ctx.inRoom;
}
