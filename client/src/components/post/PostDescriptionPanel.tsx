/**
 * ============================================================
 * 帖子描述编辑面板（PostDescriptionPanel）
 * ============================================================
 * 从 CreatePost 第 3 步抽出的右侧编辑栏：用户信息、描述输入（含 #标签预览）、
 * 表情选择器、字数统计与高级设置（关闭评论/置顶）。纯展示，状态由 CreatePost 持有。
 */
import { useMemo } from 'react';
import type { RefObject } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { extractTags } from '@k/shared';
import EmojiPicker from '../EmojiPicker';
import { resolveMediaUrl } from '../../utils';
import type { User } from '../../types';
import panel from './PostDescriptionPanel.module.css';

interface PostDescriptionPanelProps {
  user: User | null;
  description: string;
  onChange: (value: string) => void;
  /** 追加表情（主组件用函数式 setState，快速连点不丢字符） */
  onEmoji: (emoji: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  showAdvanced: boolean;
  onToggleAdvanced: () => void;
  closeComments: boolean;
  onCloseCommentsChange: (v: boolean) => void;
  pinned: boolean;
  onPinnedChange: (v: boolean) => void;
}

export default function PostDescriptionPanel({
  user,
  description,
  onChange,
  onEmoji,
  textareaRef,
  showAdvanced,
  onToggleAdvanced,
  closeComments,
  onCloseCommentsChange,
  pinned,
  onPinnedChange,
}: PostDescriptionPanelProps) {
  const descriptionTags = useMemo(() => extractTags(description), [description]);
  return (
    <div className={panel.editRight}>
      <div className={panel.user}>
        {user?.avatar ? (
          <img src={resolveMediaUrl(user.avatar) || user.avatar} alt="" className={panel.avatar} />
        ) : (
          <div className={panel.avatarPlaceholder}>{user?.username?.charAt(0).toUpperCase()}</div>
        )}
        <span className={panel.username}>{user?.username}</span>
      </div>
      <div className={panel.descWrapper}>
        <textarea
          ref={textareaRef}
          className={panel.textarea}
          value={description}
          onChange={(e) => onChange(e.target.value)}
          maxLength={2000}
          autoFocus
        />
        {descriptionTags.length > 0 && (
          <div className={panel.tagPreview}>
            {descriptionTags.map((tag) => (
              <span key={tag} className={panel.tagChip}>
                #{tag}
              </span>
            ))}
          </div>
        )}
        <div className={panel.descFooter}>
          <EmojiPicker
            onSelect={onEmoji}
            onSelected={() => {
              if (textareaRef.current) {
                textareaRef.current.focus();
                const len = textareaRef.current.value.length;
                textareaRef.current.setSelectionRange(len, len);
              }
            }}
            onOpen={() => textareaRef.current?.blur()}
            onClose={() => textareaRef.current?.focus()}
          />
          <span className={panel.charCount}>{description.length}/2000</span>
        </div>
      </div>
      <div className={panel.advanced}>
        <button className={panel.advancedToggle} onClick={onToggleAdvanced}>
          <span>高级设置</span>
          {showAdvanced ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
        {showAdvanced && (
          <div className={panel.advancedOptions}>
            <label className={panel.toggleLabel}>
              <span>关闭评论</span>
              <div
                className={`${panel.toggle} ${closeComments ? panel.on : ''}`}
                onClick={() => onCloseCommentsChange(!closeComments)}
              >
                <div className={panel.toggleKnob} />
              </div>
            </label>
            <label className={panel.toggleLabel}>
              <span>置顶</span>
              <div
                className={`${panel.toggle} ${pinned ? panel.on : ''}`}
                onClick={() => onPinnedChange(!pinned)}
              >
                <div className={panel.toggleKnob} />
              </div>
            </label>
          </div>
        )}
      </div>
    </div>
  );
}
