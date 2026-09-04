/**
 * ============================================================
 * 聊天窗口 (ChatWindow)
 * ============================================================
 * Messages 右侧聊天区：头部、消息列表（column-reverse）、引用预览、
 * 输入器与空状态（纯展示组件，数据与行为回调由 Messages 提供）
 */

import { RefObject } from 'react';
import { ChevronLeft, Trash2, MessageCircle } from 'lucide-react';
import type { Conversation, Message, User } from '../../types';
import { parseDbTime } from '../../utils';
import MessageBubble from './MessageBubble';
import ChatComposer from './ChatComposer';
import Avatar from '../ui/Avatar';
import styles from './ChatWindow.module.css';

interface ChatWindowProps {
  user: User | null;
  selectedPartner: Conversation;
  messages: Message[];
  chatMessagesRef: RefObject<HTMLDivElement | null>;
  scrollSentinelRef: RefObject<HTMLDivElement | null>;
  sending: boolean;
  quoteMsg: Message | null;
  setQuoteMsg: (m: Message | null) => void;
  imageInputRef: RefObject<HTMLInputElement | null>;
  chatInputRef: RefObject<HTMLInputElement | null>;
  onBack: () => void;
  onClear: () => void;
  onSend: (text: string) => void;
  onSendImage: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onContextMenu: (e: React.MouseEvent, msg: Message) => void;
  onTouchStart: (e: React.TouchEvent, msg: Message) => void;
  onTouchEnd: () => void;
  onTouchMove: () => void;
  onZoomImage: (url: string) => void;
  onScrollToMessage: (msgId: number) => void;
}

export default function ChatWindow({
  user, selectedPartner, messages, chatMessagesRef, scrollSentinelRef,
  sending, quoteMsg, setQuoteMsg,
  imageInputRef, chatInputRef, onBack, onClear, onSend, onSendImage,
  onContextMenu, onTouchStart, onTouchEnd, onTouchMove, onZoomImage, onScrollToMessage,
}: ChatWindowProps) {
  return (
    <>
      <div className={styles.header}>
        <button className={styles.backBtn} data-back onClick={onBack} aria-label="返回">
          <ChevronLeft size={24} />
        </button>
        <Avatar src={selectedPartner.avatar} username={selectedPartner.username} size={40} className={styles.headerAvatar} />
        <span className={styles.headerUsername}>{selectedPartner.username}</span>
        <button className={styles.clearBtn} onClick={onClear} title="清除全部消息" aria-label="清除全部消息">
          <Trash2 size={18} />
        </button>
      </div>

      <div className={styles.messages} ref={chatMessagesRef}>
        {/* column-reverse: 最新消息自然在底部，无需 spacer */}
        {[...messages].reverse().map((msg, index, reversedMsgs) => {
          const isSent = msg.sender_id === user?.id;
          const avatar = isSent ? user?.avatar : selectedPartner.avatar;
          const name = isSent ? user?.username : selectedPartner.username;

          // 相邻消息间隔超过 5 分钟时，插入时间分隔符
          // reversed: index 0=最新, 比较下一个（更旧的）消息
          const TIME_GAP_MS = 5 * 60 * 1000;
          const nextMsg = index < reversedMsgs.length - 1 ? reversedMsgs[index + 1] : null;
          const showSeparator = !nextMsg ||
            (parseDbTime(msg.created_at).getTime() - parseDbTime(nextMsg.created_at).getTime() > TIME_GAP_MS);

          return (
            <MessageBubble
              key={msg.id}
              msg={msg}
              isSent={isSent}
              avatar={avatar}
              name={name}
              showSeparator={showSeparator}
              onContextMenu={onContextMenu}
              onTouchStart={onTouchStart}
              onTouchEnd={onTouchEnd}
              onTouchMove={onTouchMove}
              onZoomImage={onZoomImage}
              onScrollToMessage={onScrollToMessage}
            />
          );
        })}
        {/* 底部哨兵 — scrollIntoView 目标，确保精确定位到最新消息 */}
        <div ref={scrollSentinelRef} aria-hidden="true" />
      </div>

      <ChatComposer
        sending={sending}
        quoteMsg={quoteMsg}
        setQuoteMsg={setQuoteMsg}
        imageInputRef={imageInputRef}
        chatInputRef={chatInputRef}
        onSend={onSend}
        onSendImage={onSendImage}
      />
    </>
  );
}

/** 聊天空状态 */
export function ChatEmpty() {
  return (
    <div className={styles.empty}>
      <div className={styles.emptyIcon}>
        <MessageCircle size={28} />
      </div>
      <div className={styles.emptyText}>私信</div>
      <div className={styles.emptySub}>发送消息开始聊天</div>
    </div>
  );
}
