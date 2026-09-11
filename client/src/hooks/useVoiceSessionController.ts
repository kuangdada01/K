/**
 * ============================================================
 * 语音会话控制器 Hook（hooks/useVoiceSessionController）
 * ============================================================
 * 自 VoiceContext.tsx 拆出（§3.3，行为逐行不变）：
 * - sessionRef 生命周期（join/leave/登出断开/刷新自动回房）
 * - 会话状态桥接：VoiceSession 回调 → 组件状态（participants/speaking/
 *   peerQuality、share 系列、recording、status）
 * - 全部控制动作（静音/录制/降噪/音乐模式/屏幕共享/音量/共享偏好）
 *
 * 文字聊天的动作经 chatActions() 注入（VoiceContext 组装 useVoiceChatStore
 * 后写入 ref，join 运行期读取——避免两个 hook 的初始化顺序循环依赖）。
 * 聊天状态本身（messages/翻页/游标）在 useVoiceChatStore。
 * ============================================================
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { VoiceSession, NOISE_REDUCTION_KEY, MUSIC_MODE_KEY } from '../voice/VoiceSession';
import type { VoiceStatus, VoiceQualityLevel, ShareQuality, ShareStats } from '../voice/VoiceSession';
import { showToast } from '../components/ui/Toast';
import type { VoiceChatMessage, VoiceParticipant } from '../types';

const ACTIVE_ROOM_KEY = 'voice:activeRoom';

/** 屏幕共享展示状态（userId=null 视为无共享；stream 就绪前舞台显示"正在接收画面"） */
export interface VoiceShareState {
  userId: number;
  stream: MediaStream | null;
  audio: boolean;
}

/** 会话运行期需要的聊天动作（VoiceContext 把 useVoiceChatStore 的动作注入进来；
 *  经函数读取 ref，join/leave 等运行期调用时一定已就绪） */
export interface SessionChatActions {
  onChatMessage(message: VoiceChatMessage): void;
  onChatCleared(): void;
  reset(): void;
}

export function useVoiceSessionController(
  user: { id: number; username: string; avatar: string | null } | null,
  chatActions: () => SessionChatActions
) {
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
  const sessionRef = useRef<VoiceSession | null>(null);
  const autoJoinTriedRef = useRef(false);
  /** 当前会话是否以「已登录身份」建立（用于区分登录过期与访客场景） */
  const authSessionRef = useRef(false);
  /** 是否刚收到 token 过期事件（auth:expired，仅由 401 拦截器派发；主动登出不算） */
  const authExpiredRef = useRef(false);

  const share = useMemo<VoiceShareState | null>(
    () => (shareUserId === null ? null : { userId: shareUserId, stream: shareStream, audio: shareAudio }),
    [shareUserId, shareStream, shareAudio]
  );
  const canScreenShare = useMemo(
    () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia,
    []
  );

  const clearSavedRoom = useCallback(() => sessionStorage.removeItem(ACTIVE_ROOM_KEY), []);

  /** 会话侧状态复位（聊天状态由 chatActions().reset() 负责，见 join/leave 调用点） */
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
  }, []);

  // chatActions 是调用方（VoiceContext）每渲染新建的函数，直接进依赖数组会让
  // join/leave 引用每次渲染都变化 → 下方 disconnect effect（[user, leave]）在
  // 每次渲染后重跑，未登录访客（user=null）join 后会被立即 leave() 踢出房间。
  // 收进 ref（effect 内同步最新值），join/leave 运行期读最新值即可（依赖数组保持稳定）。
  const chatActionsRef = useRef(chatActions);
  useEffect(() => {
    chatActionsRef.current = chatActions;
  }, [chatActions]);

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
            if (s === 'ended') {
              clearSavedRoom();
              // 会话已终结（被踢/房间被关/信令终止）：必须清掉引用，
              // 否则 join() 开头的 `if (sessionRef.current) return` 会让重新进房
              // 变成一个静默空操作 —— 用户点了「加入语音」却什么都没发生。
              // 仅在引用仍指向本会话时清理，避免误清掉之后新建的会话。
              if (sessionRef.current === session) sessionRef.current = null;
            }
          },
          onParticipants: (list) => setParticipants(list),
          onSpeaking: (userId, isSpeaking) => {
            setSpeaking((prev) => {
              // 值未变时必须返回原引用：React 只按 Object.is 跳过渲染，
              // 每次新建 Set 会让说话状态翻转时整片消费者跟着重渲染
              const has = prev.has(userId);
              if (has === isSpeaking) return prev;
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
          onChatMessage: (message) => chatActionsRef.current().onChatMessage(message),
          // 房间聊天被创建者/管理员清空：本地同步清空（游标保留，后续只追新）
          onChatCleared: () => chatActionsRef.current().onChatCleared(),
        }
      );
      sessionRef.current = session;
      // 记下本会话的身份来源：登录过期后若「已登录会话」还在房间里，
      // 客户端必须自己退房（WS 建连时 token 还有效，服务端不会主动断开它）
      authSessionRef.current = !!user;
      setShareQualityState(session.getShareQuality());
      setShareSharpTextState(session.getShareSharpText());
      setShareMuted(session.getShareMuted());
      session.join(roomId).catch(() => {
        session.leave();
        if (sessionRef.current === session) sessionRef.current = null;
        clearSavedRoom();
        resetState();
        chatActionsRef.current().reset();
        showToast('无法启动语音，请检查浏览器是否支持麦克风');
      });
    },
    [user, clearSavedRoom, resetState]
  );

  const leave = useCallback(() => {
    sessionRef.current?.leave();
    sessionRef.current = null;
    authSessionRef.current = false;
    clearSavedRoom();
    resetState();
    chatActionsRef.current().reset();
  }, [clearSavedRoom, resetState]);

  // token 过期事件（仅由 api/http.ts 的 401 拦截器派发；主动登出不会派发）。
  // 只置标记，实际退房交给下面的 [user] effect —— 那里 user 一定已经是 null。
  useEffect(() => {
    const handler = () => {
      authExpiredRef.current = true;
    };
    window.addEventListener('auth:expired', handler);
    return () => window.removeEventListener('auth:expired', handler);
  }, []);

  // 登出/登录过期：断开语音。
  //
  // 这里必须区分两种情况（线上事故根因之一）：
  // - **登录过期**：语音 WS 在 token 还有效时建连，服务端不会因为 token 过期去断它，
  //   所以房间成员会一直留在里面；而客户端所有 REST 请求开始 401。
  //   此前只是静默 leave()，用户完全不知道发生了什么，只知道「突然被踢出房间」，
  //   随后再点加入还会以**访客**身份进房（同 IP 撞 id → 被自己的另一条连接顶掉）。
  //   现在明确提示并要求重新登录。
  // - **主动登出**：用户自己点了退出，不需要额外解释（authExpiredRef 为 false）。
  // - **访客会话**：本来就没有登录身份，user 为 null 属正常，不退房。
  useEffect(() => {
    if (user || !sessionRef.current) return;
    if (authSessionRef.current && authExpiredRef.current) {
      showToast('登录已过期，请重新登录后再加入语音');
    }
    authExpiredRef.current = false;
    leave();
  }, [user, leave]);

  // 卸载清理：组件被卸载（路由切换/热更新）时释放麦克风、对等连接与信令连接。
  // 缺这段清理会让服务端房间成员永久残留 —— 一个「僵尸成员」占着房间名额，
  // 而客户端早已没有任何连接可以再把它移除（只有下一次同账号连接才会顶掉它）。
  useEffect(() => {
    return () => {
      sessionRef.current?.leave();
      sessionRef.current = null;
      authSessionRef.current = false;
    };
  }, []);

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

  // ---- 控制动作 ----
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
  const sendChat = useCallback(
    (content: string): boolean => sessionRef.current?.sendChat(content) ?? false,
    []
  );

  return {
    status,
    participants,
    speaking,
    peerQuality,
    activeRoomId,
    activeRoomName,
    isRecording,
    recordingStartedAt,
    noiseReduction,
    musicMode,
    share,
    canScreenShare,
    shareQuality,
    shareSharpText,
    shareMuted,
    shareStats,
    join,
    leave,
    toggleMute,
    toggleRecording,
    toggleNoiseReduction,
    toggleMusicMode,
    toggleScreenShare,
    setShareQuality,
    toggleShareSharpText,
    toggleShareMuted,
    setMicVolume,
    setPeerVolume,
    getPeerVolume,
    getMicVolume,
    sendChat,
  };
}
