/**
 * ============================================================
 * 聊天输入器 (ChatComposer)
 * ============================================================
 * P9 修复：输入框文字 state 从 Messages 顶层下沉到本组件，
 * 每击键只重渲染输入器本身，不再让整个消息列表（所有
 * MessageBubble）跟着重渲染。发送逻辑仍由 Messages 回调负责。
 */

import { useState } from 'react';
import { X, Image as ImageIcon, Send } from 'lucide-react';
import type { Message } from '../../types';
import EmojiPicker from '../EmojiPicker';
import styles from './ChatWindow.module.css';

interface ChatComposerProps {
  sending: boolean;
  quoteMsg: Message | null;
  setQuoteMsg: (m: Message | null) => void;
  imageInputRef: React.RefObject<HTMLInputElement | null>;
  chatInputRef: React.RefObject<HTMLInputElement | null>;
  onSend: (text: string) => void;
  onSendImage: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

export default function ChatComposer({
  sending,
  quoteMsg,
  setQuoteMsg,
  imageInputRef,
  chatInputRef,
  onSend,
  onSendImage,
}: ChatComposerProps) {
  const [text, setText] = useState('');

  const submit = () => {
    if (!text.trim() || sending) return;
    onSend(text);
    setText('');
  };

  return (
    <>
      {quoteMsg && (
        <div className={styles.quotePreview}>
          <div className={styles.quoteContent}>
            <span className={styles.quoteUser}>{quoteMsg.sender_username}</span>
            <span className={styles.quoteText}>
              {quoteMsg.image_url ? '[图片]' : quoteMsg.content || '[消息]'}
            </span>
          </div>
          <button className={styles.quoteClose} onClick={() => setQuoteMsg(null)} aria-label="取消引用">
            <X size={16} />
          </button>
        </div>
      )}

      <div className={styles.inputWrapper}>
        <div className={styles.inputContainer}>
          <EmojiPicker
            onSelect={(emoji) => setText((prev) => prev + emoji)}
            onOpen={() => {}}
            onClose={() => {}}
          />
          <button
            className={styles.imageBtn}
            onClick={() => imageInputRef.current?.click()}
            disabled={sending}
            title="发送图片"
            aria-label="发送图片"
          >
            <ImageIcon size={20} />
          </button>
          <input
            ref={imageInputRef}
            type="file"
            accept="image/jpeg,image/jpg,image/png,image/gif,image/webp,image/avif,image/heic,image/heif"
            style={{ display: 'none' }}
            onChange={onSendImage}
          />
          <input
            ref={chatInputRef}
            className={styles.input}
            placeholder="发送消息..."
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
          />
        </div>
        <button
          className={styles.sendBtn}
          onClick={submit}
          disabled={!text.trim() || sending}
          aria-label="发送"
        >
          <Send size={18} />
        </button>
      </div>
    </>
  );
}
