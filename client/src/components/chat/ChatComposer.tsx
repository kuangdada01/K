/**
 * ============================================================
 * 聊天输入器 (ChatComposer)
 * ============================================================
 * P9 修复：输入框文字 state 从 Messages 顶层下沉到本组件，
 * 每击键只重渲染输入器本身，不再让整个消息列表（所有
 * MessageBubble）跟着重渲染。发送逻辑仍由 Messages 回调负责。
 *
 * 文件上传托盘（2026-10-23）：选完文件立刻开传，进度/失败都显示在输入栏上方，
 * 成功后托盘里那一条自动消失、文件消息出现在会话里；失败保留并给「重试」。
 */

import { useState } from 'react';
import { X, Image as ImageIcon, Paperclip, RotateCw, Send } from 'lucide-react';
import type { Message } from '../../types';
import type { UploadItem } from '../../features/messages/hooks/useFileUpload';
import { formatFileSize } from '../../features/messages/utils/fileMessage';
import EmojiPicker from '../EmojiPicker';
import styles from './ChatWindow.module.css';

interface ChatComposerProps {
  sending: boolean;
  quoteMsg: Message | null;
  setQuoteMsg: (m: Message | null) => void;
  imageInputRef: React.RefObject<HTMLInputElement | null>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  chatInputRef: React.RefObject<HTMLInputElement | null>;
  uploadItems: UploadItem[];
  onSend: (text: string) => void;
  onSendImage: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onPickFiles: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRetryUpload: (id: string) => void;
  onDismissUpload: (id: string) => void;
}

/** 引用条摘要：文件消息没有正文，用「[文件] 名字」代替 */
function quoteText(m: Message): string {
  if (m.audio_url) return '[语音]';
  if (m.file_url) return `[文件] ${m.file_name || ''}`.trim();
  if (m.image_url) return '[图片]';
  return m.content || '[消息]';
}

export default function ChatComposer({
  sending,
  quoteMsg,
  setQuoteMsg,
  imageInputRef,
  fileInputRef,
  chatInputRef,
  uploadItems,
  onSend,
  onSendImage,
  onPickFiles,
  onRetryUpload,
  onDismissUpload,
}: ChatComposerProps) {
  const [text, setText] = useState('');

  const submit = () => {
    if (!text.trim() || sending) return;
    onSend(text);
    setText('');
  };

  return (
    <div className={styles.composerStack}>
      {(quoteMsg || uploadItems.length > 0) && (
        <div className={styles.composerDock}>
          {quoteMsg && (
            <div className={styles.quotePreview}>
              <div className={styles.quoteContent}>
                <span className={styles.quoteUser}>{quoteMsg.sender_username}</span>
                <span className={styles.quoteText}>{quoteText(quoteMsg)}</span>
              </div>
              <button className={styles.quoteClose} onClick={() => setQuoteMsg(null)} aria-label="取消引用">
                <X size={16} />
              </button>
            </div>
          )}

          {uploadItems.length > 0 && (
            <div className={styles.uploadTray} role="status" aria-live="polite">
              {uploadItems.map((item) => (
                <div key={item.id} className={styles.uploadItem}>
                  <div className={styles.uploadHead}>
                    <span className={styles.uploadName} title={item.name}>
                      {item.name}
                    </span>
                    <span className={styles.uploadSize}>
                      {item.status === 'failed' ? '发送失败' : `${item.progress}%`}
                    </span>
                    {item.status === 'failed' ? (
                      <button
                        className={styles.uploadIconBtn}
                        onClick={() => onRetryUpload(item.id)}
                        title="重试"
                        aria-label="重试"
                      >
                        <RotateCw size={15} />
                      </button>
                    ) : null}
                    <button
                      className={styles.uploadIconBtn}
                      onClick={() => onDismissUpload(item.id)}
                      title={item.status === 'failed' ? '移除' : '取消上传'}
                      aria-label={item.status === 'failed' ? '移除' : '取消上传'}
                    >
                      <X size={15} />
                    </button>
                  </div>
                  <div className={styles.uploadBar}>
                    <div
                      className={`${styles.uploadBarFill} ${
                        item.status === 'failed' ? styles.uploadBarFailed : ''
                      }`}
                      style={{ width: `${item.status === 'failed' ? 100 : item.progress}%` }}
                    />
                  </div>
                  <div className={styles.uploadFoot}>
                    {item.status === 'failed' ? (
                      <span className={styles.uploadError}>{item.error || '发送失败'}</span>
                    ) : (
                      <span>{formatFileSize(item.size)}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
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
            onClick={() => fileInputRef.current?.click()}
            title="发送文件"
            aria-label="发送文件"
          >
            <Paperclip size={20} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            // 不设 accept：类型不限（apk/exe 也能发），选择器不再灰掉任何文件
            style={{ display: 'none' }}
            onChange={onPickFiles}
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
            name="chat-message"
            placeholder="发送消息..."
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // §5.2：中文输入法选词回车（isComposing）不发送；
              // 移动端 isComposing 可能为 undefined，按 false 处理（不拦截）
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit();
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
    </div>
  );
}
