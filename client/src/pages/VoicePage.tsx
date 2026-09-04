/**
 * ============================================================
 * 语音房间页面 (VoicePage)
 * ============================================================
 * Kook 式语音频道:
 * - 未进房: 房间列表（在线人数徽标、活跃房间排前）+ 创建房间
 * - 进房后: 参与者卡片网格（说话光环、静音标识、单人音量滑条）
 *   + 底部控制栏（麦克风开关、全房间录制、麦克风音量、退出）
 * 实时逻辑全部在 VoiceContext（WS 信令 + WebRTC Mesh，应用级、切页不断开）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AudioLines, Mic, MicOff, AudioWaveform, Headphones, Plus, Trash2, Volume2, Radio,
  Music, // 音乐模式图标（高保真立体声档）
  Circle, // 录制按钮空闲态的实心圆点
  LogOut, // 退出房间图标；水平镜像后：门在右侧、箭头朝左
  MonitorUp, // 屏幕共享图标；共享中高亮显示
  MessageSquareText, // 文字聊天面板标题
  Eraser, // 清空聊天记录
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useVoice, useVoiceRealtime } from '../context/VoiceContext';
import { listVoiceRooms, createVoiceRoom, deleteVoiceRoom, clearVoiceRoomMessages } from '../api/voice';
import { showToast } from '../components/ui/Toast';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import Avatar from '../components/ui/Avatar';
import VoiceShareStage from '../components/VoiceShareStage';
import type { VoiceRoom, VoiceParticipant, VoiceChatMessage } from '../types';
import type { VoiceQualityLevel } from '../voice/VoiceSession';
import { VOICE_MAX_ROOM_SIZE } from '@k/shared';
import styles from './VoicePage.module.css';

/** 朗读开关的 localStorage 键（同降噪/音乐模式的偏好持久化惯例） */
const CHAT_TTS_KEY = 'voice:chatTTS';

/**
 * 判断消息内容语言（只对内容判定，不含用户名，避免英文用户名带偏检测）：
 * - 含中文 → zh（中文优先）
 * - 纯英文字母 → en
 * - 无中文也无字母（纯数字/符号/表情，如 666）→ zh（数字用中文念法："666"→"六六六"）
 */
function detectSpeakLang(text: string): 'zh' | 'en' {
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? []).length;
  if (cjk > 0) return 'zh';
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  if (latin > 0) return 'en';
  return 'zh';
}

export default function VoicePage() {
  const { user } = useAuth();
  const voice = useVoice();
  const realtime = useVoiceRealtime();

  const [rooms, setRooms] = useState<VoiceRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [deletingRoom, setDeletingRoom] = useState<VoiceRoom | null>(null);
  // 滑条受控值（session 内部持久化，这里镜像以便渲染）
  const [micVolume, setMicVolume] = useState(1);
  // 录制已录秒数（interval 回调里由开始时间戳推算；开始新一轮录制时归零）
  const [recSeconds, setRecSeconds] = useState(0);
  const nameInputRef = useRef<HTMLInputElement>(null);
  // ---- 文字聊天（历史持久化在服务端，进入房间时自动加载最近记录） ----
  const [chatDraft, setChatDraft] = useState('');
  const [clearingChat, setClearingChat] = useState(false);
  const chatListRef = useRef<HTMLDivElement>(null);
  /** 用户是否停留在消息列表底部（决定新消息是否自动滚动） */
  const autoScrollRef = useRef(true);

  // ---- 聊天朗读（Web Speech API；只读实时新消息，格式「用户名说内容」） ----
  /** 浏览器是否支持语音合成（不支持时开关置灰） */
  const ttsSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;
  /** 朗读开关（默认关；偏好持久化） */
  const [ttsEnabled, setTtsEnabled] = useState(() => localStorage.getItem(CHAT_TTS_KEY) === '1');
  /** 正在朗读的消息 id（用于高亮与"再点停止"） */
  const [speakingMsgId, setSpeakingMsgId] = useState<number | null>(null);
  /** 当前是否在播放中（队列调度用，避免 onend/onerror 竞态重入） */
  const speakingRef = useRef(false);
  /** 已朗读过的消息 id：防止打开开关瞬间补读开关前的最后一条实时消息 */
  const lastReadMsgIdRef = useRef<number | null>(null);
  /** 可用语音缓存（getVoices 异步就绪，voiceschanged 事件刷新） */
  const voicesRef = useRef<{ zh: SpeechSynthesisVoice | null; en: SpeechSynthesisVoice | null }>({ zh: null, en: null });

  /** 停止朗读（打断当前 + 清状态） */
  const stopTTS = useCallback(() => {
    if (!ttsSupported) return;
    window.speechSynthesis.cancel();
    speakingRef.current = false;
    setSpeakingMsgId(null);
  }, [ttsSupported]);

  /** 朗读一条消息：新消息打断正在播的旧消息（最新优先），播完自动复位 */
  const speakMessage = useCallback((id: number, text: string, lang: 'zh' | 'en') => {
    if (!ttsSupported) return;
    const synth = window.speechSynthesis;
    // 先打断正在播的（若正在播同一条则是"再点停止"语义，由调用方处理）
    synth.cancel();
    speakingRef.current = false;
    setSpeakingMsgId(id);
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = lang === 'zh' ? 'zh-CN' : 'en-US';
    const voice = lang === 'zh' ? voicesRef.current.zh : voicesRef.current.en;
    if (voice) utter.voice = voice;
    utter.onend = () => { speakingRef.current = false; setSpeakingMsgId(null); };
    utter.onerror = () => { speakingRef.current = false; setSpeakingMsgId(null); };
    // Chrome 在 cancel 后立即 speak 可能静默失败（crbug 已知问题），
    // 延迟到下一个宏任务再播，避开 cancel 的内部异步清理窗口
    setTimeout(() => { if (!speakingRef.current) synth.speak(utter); }, 0);
  }, [ttsSupported]);

  /** 点击消息手动朗读（自己的消息也可读）；再点正在朗读的同一消息 → 停止 */
  const handleSpeakMessage = useCallback((m: VoiceChatMessage) => {
    if (!ttsSupported) { showToast('当前浏览器不支持朗读'); return; }
    if (speakingMsgId === m.id) { stopTTS(); return; }
    // 语言只按消息内容判定（666 → 中文"六六六"；英文内容 → 英文语音）
    speakMessage(m.id, `${m.username}说${m.content}`, detectSpeakLang(m.content));
  }, [ttsSupported, speakingMsgId, stopTTS, speakMessage]);

  /** 朗读开关：开=自动朗读新消息，关=立即停止并清队列 */
  const toggleTTS = useCallback(() => {
    setTtsEnabled(prev => {
      const next = !prev;
      localStorage.setItem(CHAT_TTS_KEY, next ? '1' : '0');
      if (next) {
        // 打开瞬间：把开关前最后一条实时消息标记为已读，避免补读旧消息
        lastReadMsgIdRef.current = voice.liveMessage?.id ?? null;
      } else {
        stopTTS();
      }
      return next;
    });
  }, [voice.liveMessage, stopTTS]);

  // 语音包列表异步加载（Chrome 首次 getVoices 可能为空，监听 voiceschanged）
  useEffect(() => {
    if (!ttsSupported) return;
    const loadVoices = () => {
      const voices = window.speechSynthesis.getVoices();
      voicesRef.current = {
        zh: voices.find(v => v.lang.toLowerCase().startsWith('zh')) ?? null,
        en: voices.find(v => v.lang.toLowerCase().startsWith('en')) ?? null,
      };
    };
    loadVoices();
    window.speechSynthesis.addEventListener('voiceschanged', loadVoices);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', loadVoices);
  }, [ttsSupported]);

  // 自动朗读：开关开启 + 有新实时消息 + 非自己发的 → 播报「用户名说内容」
  useEffect(() => {
    if (!ttsEnabled || !voice.liveMessage) return;
    const m = voice.liveMessage;
    if (m.id === lastReadMsgIdRef.current) return;
    lastReadMsgIdRef.current = m.id;
    // 自己的消息不自动朗读（避免与麦克风回声串扰；手动点击仍可朗读）
    const self = voice.participants[0];
    if (self && m.sender_id === self.userId) return;
    // 异步派发朗读（speakMessage 内部会 setState 高亮，避免在 effect 内同步触发级联渲染）
    queueMicrotask(() => speakMessage(m.id, `${m.username}说${m.content}`, detectSpeakLang(m.content)));
  }, [ttsEnabled, voice.liveMessage, voice.participants, speakMessage]);

  // 退出房间 / 组件卸载：立即停止朗读
  useEffect(() => {
    if (!voice.inRoom) queueMicrotask(stopTTS);
    return () => stopTTS();
  }, [voice.inRoom, stopTTS]);

  // 页面切到后台：停止朗读（避免标签页不可见时还在出声）
  useEffect(() => {
    if (!ttsSupported) return;
    const onVisibility = () => { if (document.hidden) queueMicrotask(stopTTS); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [ttsSupported, stopTTS]);

  const refreshRooms = useCallback(() => {
    listVoiceRooms()
      .then(res => setRooms(res.rooms || []))
      .catch(() => { /* 静默失败，保留下次刷新 */ });
  }, []);

  useEffect(() => {
    listVoiceRooms()
      .then(res => setRooms(res.rooms || []))
      .catch(() => setRooms([]))
      .finally(() => setLoading(false));
  }, []);

  // 进房期间轮询房间列表（人数徽标实时化）；会话结束后刷新一次
  useEffect(() => {
    if (!voice.inRoom) return;
    const timer = window.setInterval(refreshRooms, 10_000);
    return () => clearInterval(timer);
  }, [voice.inRoom, refreshRooms]);

  useEffect(() => {
    if (voice.status === 'ended') refreshRooms();
  }, [voice.status, refreshRooms]);

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

  const handleJoin = (room: VoiceRoom) => {
    if ((room.participantCount ?? 0) >= VOICE_MAX_ROOM_SIZE) { showToast('房间已满'); return; }
    // 未登录用户以访客身份进入（服务端分配负数 id，显示"未登录-N"）
    voice.join(room.id, room.name);
    setMicVolume(voice.getMicVolume());
  };

  const handleLeave = () => voice.leave();

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) { showToast('请输入房间名'); return; }
    try {
      // 未登录用户也可以创建房间（服务端以访客身份分配创建者归属）
      const res = await createVoiceRoom(name, newDesc.trim() || undefined);
      setCreating(false);
      setNewName('');
      setNewDesc('');
      refreshRooms();
      showToast(`房间「${res.room.name}」已创建`);
    } catch (e: any) {
      showToast(e?.response?.data?.error || '创建失败');
    }
  };

  const handleDelete = async () => {
    if (!deletingRoom) return;
    try {
      await deleteVoiceRoom(deletingRoom.id);
      showToast('房间已删除');
    } catch (e: any) {
      showToast(e?.response?.data?.error || '删除失败');
    }
    setDeletingRoom(null);
    refreshRooms();
  };

  // ---- 文字聊天 ----
  const handleSendChat = () => {
    const content = chatDraft;
    if (!content.trim()) return;
    if (voice.sendChat(content)) {
      setChatDraft('');
      // 自己发完立即回到底部等待新消息
      autoScrollRef.current = true;
    } else {
      showToast('消息未发出：请确认已连接房间');
    }
  };

  const confirmClearChat = async () => {
    setClearingChat(false);
    if (!voice.activeRoomId) return;
    try {
      await clearVoiceRoomMessages(voice.activeRoomId);
      showToast('聊天记录已清空');
    } catch (e: any) {
      showToast(e?.response?.data?.error || '清空失败');
    }
  };

  // 新消息到达时自动滚到底部（用户手动上翻查看历史时不打扰）
  const chatMessages = voice.messages;
  useEffect(() => {
    const el = chatListRef.current;
    if (el && autoScrollRef.current) el.scrollTop = el.scrollHeight;
  }, [chatMessages]);

  // ============================================================
  // 进房视图
  // ============================================================
  if (voice.inRoom) {
    const self = voice.participants[0];
    const isSharingSelf = !!voice.share && voice.share.userId === self?.userId;
    // 当前房间的创建者身份来自轮询的房间列表（isCreator 由服务端按访问者计算，
    // 访客创建者按 IP 归属；游客/管理员同样可管理）
    const currentRoom = rooms.find(r => r.id === voice.activeRoomId) ?? null;
    const canClearChat = currentRoom !== null && (currentRoom.isCreator === true || user?.role === 'admin');
    return (
      <div className={styles.page}>
        <div className={styles.roomHeader}>
          <button className={styles.backBtn} data-back onClick={handleLeave} title="退出房间">
            <LogOut size={18} style={{ transform: 'scaleX(-1)' }} />
          </button>
          <div className={styles.roomTitleWrap}>
            <h1 className={styles.roomTitle}>{voice.activeRoomName ?? '语音房间'}</h1>
            <span className={styles.roomCount}>
              {voice.status === 'reconnecting' ? '重连中…' : `${voice.participants.length}/${VOICE_MAX_ROOM_SIZE} 人在线`}
            </span>
          </div>
        </div>

        {/* 屏幕共享舞台（16:9，可全屏）：有人共享时显示在成员网格上方 */}
        {voice.share && <VoiceShareStage />}

        <div className={styles.memberGrid}>
          {voice.participants.map(p => (
            <MemberCard
              key={p.userId}
              participant={p}
              speaking={realtime.speaking.has(p.userId)}
              isSelf={p.userId === self?.userId}
              quality={realtime.peerQuality[p.userId] ?? 'good'}
              onVolume={(userId, v) => voice.setPeerVolume(userId, v)}
              getVolume={voice.getPeerVolume}
            />
          ))}
        </div>

        {/* 文字聊天：走信令通道与语音媒体分离，语音质量差时仍可打字交流；
            历史持久化在服务端，进房自动加载，仅创建者/管理员可清空 */}
        <div className={styles.chatPanel}>
          <div className={styles.chatHeader}>
            <MessageSquareText size={15} />
            <span>文字聊天</span>
            {/* 朗读开关：开启后自动朗读新收到的消息（格式「用户名说内容」） */}
            <button
              className={`${styles.ttsBtn} ${ttsEnabled ? styles.ttsOn : styles.ttsOff}`}
              onClick={toggleTTS}
              disabled={!ttsSupported}
              title={!ttsSupported
                ? '当前浏览器不支持朗读'
                : ttsEnabled
                  ? '关闭新消息自动朗读'
                  : '开启新消息自动朗读（自动识别中英文）'}
            >
              <Volume2 size={13} />
              <span>{ttsEnabled ? '朗读开' : '朗读'}</span>
            </button>
            {canClearChat && (
              <button
                className={styles.chatClearBtn}
                onClick={() => setClearingChat(true)}
                title="清空本房间的全部聊天记录（仅创建者/管理员）"
              >
                <Eraser size={13} />
                <span>清空</span>
              </button>
            )}
          </div>
          <div
            className={styles.chatList}
            ref={chatListRef}
            onScroll={e => {
              const el = e.currentTarget;
              autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
            }}
          >
            {chatMessages.length === 0 ? (
              <div className={styles.chatEmpty}>还没有消息，说点什么吧～</div>
            ) : (
              <>
                {voice.chatHasMore && (
                  <button
                    className={styles.chatLoadMore}
                    onClick={voice.loadMoreChat}
                    disabled={voice.chatLoadingMore}
                  >
                    {voice.chatLoadingMore ? '加载中…' : '加载更早的消息'}
                  </button>
                )}
                {chatMessages.map(m => {
                  const mine = self !== undefined && m.sender_id === self.userId;
                  return (
                    <div
                      key={m.id}
                      className={styles.chatMsg}
                      onClick={() => handleSpeakMessage(m)}
                      title="点击朗读这条消息"
                    >
                      <Avatar src={m.avatar} username={m.username} size={26} />
                      <div className={styles.chatMsgBody}>
                        <div className={styles.chatMsgMeta}>
                          <span className={styles.chatMsgName}>{m.username}{mine ? '（我）' : ''}</span>
                          <span className={styles.chatMsgTime}>{formatChatTime(m.created_at)}</span>
                        </div>
                        <div className={styles.chatMsgText}>{m.content}</div>
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </div>
          <div className={styles.chatInputRow}>
            <input
              className={styles.chatInput}
              placeholder="输入消息，回车发送（500字以内）"
              value={chatDraft}
              maxLength={500}
              onChange={e => setChatDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleSendChat();
              }}
            />
            <button className={styles.chatSendBtn} onClick={handleSendChat} disabled={!chatDraft.trim()}>
              发送
            </button>
          </div>
        </div>

        {clearingChat && (
          <ConfirmDialog
            message="确定清空本房间的聊天记录吗？清空后不可恢复。"
            onConfirm={confirmClearChat}
            onCancel={() => setClearingChat(false)}
          />
        )}

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
            title={voice.musicMode
              ? '音乐模式下处理链已关闭（降噪与音乐保真互斥）'
              : voice.noiseReduction ? '关闭降噪（恢复原声）' : '打开降噪：只保留人声，降低风扇/空调等环境声'}
          >
            <AudioWaveform size={16} />
            <span>{voice.noiseReduction ? '降噪开' : '降噪'}</span>
          </button>

          <button
            className={`${styles.noiseBtn} ${voice.musicMode ? styles.noiseOn : styles.noiseOff}`}
            onClick={voice.toggleMusicMode}
            title={voice.musicMode
              ? '关闭音乐模式（恢复语音优化档：降噪/回声消除/抗丢包冗余）'
              : '音乐模式：音质升为 96k 立体声，关闭回声消除与降噪（适合播放/演唱音乐，请佩戴耳机）'}
          >
            <Music size={16} />
            <span>{voice.musicMode ? '音乐开' : '音乐'}</span>
          </button>

          {voice.canScreenShare && (
            <button
              className={`${styles.shareBtn} ${isSharingSelf ? styles.shareOn : styles.shareOff}`}
              onClick={voice.toggleScreenShare}
              title={isSharingSelf ? '停止屏幕共享' : '共享屏幕给全房间（整屏共享受浏览器限制约 30-40fps；共享标签页/应用窗口可更流畅。观看者越多越占上传带宽）'}
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
                  {String(Math.floor(recSeconds / 60)).padStart(2, '0')}:{String(recSeconds % 60).padStart(2, '0')}
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
              onChange={v => {
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

  // ============================================================
  // 房间列表视图
  // ============================================================
  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1>语音</h1>
        <button className={styles.createBtn} onClick={() => {
          // 未登录用户也可以创建房间（以访客身份）
          setCreating(true); setTimeout(() => nameInputRef.current?.focus(), 50);
        }}>
          <Plus size={16} />
          <span>创建房间</span>
        </button>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-secondary)' }}>加载中...</div>
      ) : rooms.length === 0 ? (
        <div className={styles.empty}>
          <Radio size={48} />
          <p>还没有语音房间，创建一个吧</p>
        </div>
      ) : (
        <div className={styles.roomList}>
          {rooms.map(room => {
            const count = room.participantCount ?? 0;
            const active = count > 0;
            // 删除权限：房间创建者（含访客创建者，isCreator 由服务端按访问者计算）或管理员
            const canDelete = room.isCreator === true || user?.role === 'admin';
            return (
              <div key={room.id} className={`${styles.roomCard} ${active ? styles.roomActive : ''}`}>
                <div className={styles.roomIcon}>
                  {active ? <AudioLines size={22} /> : <Headphones size={22} />}
                </div>
                <button className={styles.roomBody} onClick={() => handleJoin(room)}>
                  <div className={styles.roomName}>{room.name}</div>
                  <div className={styles.roomMeta}>
                    {room.description ? <span className={styles.roomDesc}>{room.description}</span> : null}
                    <span>by {room.creator_username}</span>
                  </div>
                </button>
                <span className={`${styles.countBadge} ${active ? styles.countLive : ''}`}>
                  {count}/{VOICE_MAX_ROOM_SIZE}
                </span>
                {canDelete && (
                  <button className={styles.deleteBtn} title="删除房间" onClick={() => setDeletingRoom(room)}>
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 创建房间弹层 */}
      {creating && (
        <div className={styles.modalMask} onClick={() => setCreating(false)}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <h2>创建语音房间</h2>
            <input
              ref={nameInputRef}
              className={styles.input}
              placeholder="房间名（1-30字）"
              value={newName}
              maxLength={30}
              onChange={e => setNewName(e.target.value)}
            />
            <input
              className={styles.input}
              placeholder="简介（可选，100字以内）"
              value={newDesc}
              maxLength={100}
              onChange={e => setNewDesc(e.target.value)}
            />
            <div className={styles.modalActions}>
              <button className={styles.cancelBtn} onClick={() => setCreating(false)}>取消</button>
              <button className={styles.confirmBtn} onClick={handleCreate}>创建</button>
            </div>
          </div>
        </div>
      )}

      {/* 删除房间确认 */}
      {deletingRoom && (
        <ConfirmDialog
          message={`确定删除房间「${deletingRoom.name}」吗？房内成员会被请出。`}
          onConfirm={handleDelete}
          onCancel={() => setDeletingRoom(null)}
        />
      )}
    </div>
  );
}

/** 参与者卡片：头像 + 说话光环 + 静音标识 + 右上角网络质量点 + 单人音量条 */
function MemberCard({
  participant, speaking, isSelf, quality, onVolume, getVolume,
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
        {participant.username}{isSelf ? '（我）' : ''}
      </div>
      {!isSelf && (
        <div className={styles.peerVolume}>
          <Volume2 size={13} />
          <VolumeSlider
            value={volume}
            onChange={v => {
              setVolume(v);
              onVolume(participant.userId, v);
            }}
          />
        </div>
      )}
    </div>
  );
}

/** 音量滑条（4px 细轨道，填充随值变化；max 默认 1，麦克风用 1.5 配合总线压限拉高低声麦） */
function VolumeSlider({ value, onChange, max = 1 }: { value: number; onChange: (v: number) => void; max?: number }) {
  const pct = Math.round(Math.min(1, Math.max(0, value / max)) * 100);
  return (
    <input
      type="range" min={0} max={max} step={0.05}
      className={styles.slider}
      style={{ background: `linear-gradient(to right, var(--accent) ${pct}%, var(--bg-secondary) ${pct}%)` }}
      value={value}
      onChange={e => onChange(Number(e.target.value))}
    />
  );
}

/** 聊天消息时间：今天只显示时分，跨天显示"月日 时分" */
function formatChatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}
