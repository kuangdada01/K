/**
 * ============================================================
 * 语音房间文字聊天面板（pages/voice/VoiceChatPanel）
 * ============================================================
 * 自 VoicePage.tsx 拆出（§3.2，行为不变）：
 * - 聊天列表（自动滚动、上翻查看历史不打扰、加载更早消息）
 * - 发送（回车/按钮；isComposing 守卫）、清空（创建者/管理员）
 * - 朗读开关与点击消息朗读（useChatTTS，含两处 P2 修复）
 * 样式复用 VoicePage.module.css（与拆分前同一份 CSS，视觉零变化）。
 * ============================================================
 */

import { useEffect, useRef, useState } from 'react';
import { Eraser, MessageSquareText, Volume2 } from 'lucide-react';
import { useVoice, useVoiceChat } from '../../context/VoiceContext';
import { clearVoiceRoomMessages } from '../../api/voice';
import { showToast } from '../../components/ui/Toast';
import { getApiErrorMessage } from '../../api/http';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import Avatar from '../../components/ui/Avatar';
import { useChatTTS } from '../../hooks/useChatTTS';
import styles from '../VoicePage.module.css';

/** 聊天消息时间：今天只显示时分，跨天显示"月日 时分" */
function formatChatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

export default function VoiceChatPanel({
  canClearChat,
  activeRoomId,
}: {
  canClearChat: boolean;
  activeRoomId: number | null;
}) {
  const voice = useVoice();
  const chat = useVoiceChat();
  const tts = useChatTTS({
    liveMessage: chat.liveMessage,
    participants: voice.participants,
    inRoom: voice.inRoom,
  });

  const [chatDraft, setChatDraft] = useState('');
  const [clearingChat, setClearingChat] = useState(false);
  const chatListRef = useRef<HTMLDivElement>(null);
  /** 用户是否停留在消息列表底部（决定新消息是否自动滚动） */
  const autoScrollRef = useRef(true);

  const handleSendChat = () => {
    const content = chatDraft;
    if (!content.trim()) return;
    if (chat.sendChat(content)) {
      setChatDraft('');
      // 自己发完立即回到底部等待新消息
      autoScrollRef.current = true;
    } else {
      showToast('消息未发出：请确认已连接房间');
    }
  };

  const confirmClearChat = async () => {
    setClearingChat(false);
    if (!activeRoomId) return;
    try {
      await clearVoiceRoomMessages(activeRoomId);
      showToast('聊天记录已清空');
    } catch (e) {
      showToast(getApiErrorMessage(e, '清空失败'));
    }
  };

  // 新消息到达时自动滚到底部（用户手动上翻查看历史时不打扰）
  const chatMessages = chat.messages;
  useEffect(() => {
    const el = chatListRef.current;
    if (el && autoScrollRef.current) el.scrollTop = el.scrollHeight;
  }, [chatMessages]);

  const self = voice.participants[0];

  return (
    <>
      {/* 文字聊天：走信令通道与语音媒体分离，语音质量差时仍可打字交流；
          历史持久化在服务端，进房自动加载，仅创建者/管理员可清空 */}
      <div className={styles.chatPanel}>
        <div className={styles.chatHeader}>
          <MessageSquareText size={15} />
          <span>文字聊天</span>
          {/* 朗读开关：开启后自动朗读新收到的消息（格式「用户名说内容」） */}
          <button
            className={`${styles.ttsBtn} ${tts.ttsEnabled ? styles.ttsOn : styles.ttsOff}`}
            onClick={tts.toggleTTS}
            disabled={!tts.ttsSupported}
            title={
              !tts.ttsSupported
                ? '当前浏览器不支持朗读'
                : tts.ttsEnabled
                  ? '关闭新消息自动朗读'
                  : '开启新消息自动朗读（自动识别中英文）'
            }
          >
            <Volume2 size={13} />
            <span>{tts.ttsEnabled ? '朗读开' : '朗读'}</span>
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
          onScroll={(e) => {
            const el = e.currentTarget;
            autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
          }}
        >
          {chatMessages.length === 0 ? (
            <div className={styles.chatEmpty}>还没有消息，说点什么吧～</div>
          ) : (
            <>
              {chat.chatHasMore && (
                <button
                  className={styles.chatLoadMore}
                  onClick={chat.loadMoreChat}
                  disabled={chat.chatLoadingMore}
                >
                  {chat.chatLoadingMore ? '加载中…' : '加载更早的消息'}
                </button>
              )}
              {chatMessages.map((m) => {
                const mine = self !== undefined && m.sender_id === self.userId;
                return (
                  <div
                    key={m.id}
                    className={styles.chatMsg}
                    onClick={() => tts.handleSpeakMessage(m)}
                    title="点击朗读这条消息"
                  >
                    <Avatar src={m.avatar} username={m.username} size={26} />
                    <div className={styles.chatMsgBody}>
                      <div className={styles.chatMsgMeta}>
                        <span className={styles.chatMsgName}>
                          {m.username}
                          {mine ? '（我）' : ''}
                        </span>
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
            name="chat-message"
            placeholder="输入消息，回车发送（500字以内）"
            value={chatDraft}
            maxLength={500}
            onChange={(e) => setChatDraft(e.target.value)}
            onKeyDown={(e) => {
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
    </>
  );
}
