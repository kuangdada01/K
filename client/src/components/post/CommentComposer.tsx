/**
 * ============================================================
 * 评论输入区（CommentComposer）
 * ============================================================
 * 从 PostDetail 抽出的纯展示组件：回复提示条 + 表情选择器 + 输入框 + 发送按钮。
 * 未登录时输入框只读，任何交互经 onRequireLogin 上抛弹出登录提示。
 */
import type { RefObject } from 'react';
import { Send } from 'lucide-react';
import EmojiPicker from '../EmojiPicker';
import styles from './PostDetail.module.css';

interface CommentComposerProps {
  isLoggedIn: boolean;
  /** 正在回复的目标（null = 顶级评论） */
  replyingTo: { id: number; username: string } | null;
  submitting: boolean;
  value: string;
  inputRef: RefObject<HTMLInputElement | null>;
  onChange: (value: string) => void;
  /** 追加表情（主组件用函数式 setState，快速连点不丢字符） */
  onEmoji: (emoji: string) => void;
  onSubmit: () => void;
  onCancelReply: () => void;
  onRequireLogin: () => void;
}

export default function CommentComposer({
  isLoggedIn,
  replyingTo,
  submitting,
  value,
  inputRef,
  onChange,
  onEmoji,
  onSubmit,
  onCancelReply,
  onRequireLogin,
}: CommentComposerProps) {
  return (
    <>
      {replyingTo && (
        <div className={styles.replyingToBar}>
          回复 @{replyingTo.username}
          <button onClick={onCancelReply}>取消</button>
        </div>
      )}
      <div
        className={styles.inputWrapper}
        onClick={() => {
          if (!isLoggedIn) onRequireLogin();
        }}
      >
        <EmojiPicker
          onSelect={onEmoji}
          onOpen={() => {
            if (!isLoggedIn) onRequireLogin();
          }}
          onClose={() => {}}
        />
        <input
          ref={inputRef}
          className={`${styles.input}${!isLoggedIn ? ` ${styles.inputLocked}` : ''}`}
          placeholder={
            isLoggedIn
              ? replyingTo
                ? `回复 @${replyingTo.username}...`
                : '添加评论...'
              : '登录后即可评论'
          }
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
          onFocus={() => {
            if (!isLoggedIn) onRequireLogin();
          }}
          readOnly={!isLoggedIn}
        />
        <button
          className={styles.submit}
          onClick={onSubmit}
          disabled={!isLoggedIn || !value.trim() || submitting}
          aria-label="发送评论"
        >
          <Send size={20} />
        </button>
      </div>
    </>
  );
}
