/**
 * ============================================================
 * 表情选择器组件 (EmojiPicker)
 * ============================================================
 * 桌面端: 320x324 弹窗，7列表情，显示在表情图标旁
 * 移动端: 底部全宽弹出面板
 *
 * 功能:
 * - 64个常用表情
 * - 点击外部自动关闭
 * - 桌面端/移动端自适应布局
 *
 * D5（2026-10-11）：桌面/移动两个面板此前是两份几乎相同的内联样式 JSX
 * （表情按钮样式重复两遍、hover 靠 JS onMouseOver/Out 改 style）——
 * 抽出共用的 renderEmojiGrid，样式迁 EmojiPicker.module.css，hover 走 CSS 伪类。
 * 面板各自的定位/尺寸差异保留在 .panelDesktop / .panelMobile 两个变体类里。
 * ============================================================
 */

import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Smile } from 'lucide-react';
import styles from './EmojiPicker.module.css';

const EMOJI_LIST = [
  '😀',
  '😃',
  '😄',
  '😁',
  '😆',
  '😅',
  '🤣',
  '😂',
  '🙂',
  '😊',
  '😇',
  '🥰',
  '😍',
  '🤩',
  '😘',
  '😗',
  '😋',
  '😛',
  '😜',
  '🤪',
  '😝',
  '🤑',
  '🤗',
  '🤭',
  '🤫',
  '🤔',
  '🤐',
  '🤨',
  '😐',
  '😑',
  '😶',
  '😏',
  '😒',
  '🙄',
  '😬',
  '😮',
  '🤥',
  '😌',
  '😔',
  '😪',
  '🤤',
  '😴',
  '😷',
  '🤒',
  '🤕',
  '🤢',
  '🤮',
  '🥵',
  '🥶',
  '🥴',
  '😵',
  '🤯',
  '🤠',
  '🥳',
  '😎',
  '👍',
  '👎',
  '👏',
  '🙌',
  '🤝',
  '❤️',
  '🔥',
  '⭐',
  '💯',
  '🎉',
  '🎊',
  '💐',
  '🌹',
  '✨',
  '💫',
  '🎵',
];

interface EmojiPickerProps {
  onSelect: (emoji: string) => void;
  onSelected?: () => void;
  onOpen?: () => void;
  onClose?: () => void;
}

export default function EmojiPicker({ onSelect, onSelected, onOpen, onClose }: EmojiPickerProps) {
  const [open, setOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [panelPos, setPanelPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const handleToggle = () => {
    if (!open && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      const PANEL_W = isMobile ? window.innerWidth : 320;
      const PANEL_H = isMobile ? 240 : 324;
      const GAP = 8;

      // 优先显示在按钮上方，空间不够则放下方
      let top = rect.top - PANEL_H - GAP;
      if (top < 8) top = rect.bottom + GAP;

      // 水平方向：按钮左侧对齐，超出视口则右对齐
      let left = isMobile ? 8 : rect.left;
      if (left + PANEL_W > window.innerWidth - 8) left = window.innerWidth - PANEL_W - 8;
      if (left < 8) left = 8;

      setPanelPos({ top, left });
    }
    setOpen(!open);
    if (!open) {
      setTimeout(() => onOpen?.(), 0);
    }
  };

  const handleSelect = (emoji: string) => {
    onSelect(emoji);
    setOpen(false);
    onClose?.();
    setTimeout(() => onSelected?.(), 50);
  };

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-emoji-panel]')) {
        setOpen(false);
        onClose?.();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open, onClose]);

  /** 表情网格：桌面/移动共用同一份渲染（差异只在面板容器的列数与尺寸） */
  const emojiGrid = (
    <>
      {EMOJI_LIST.map((emoji) => (
        <button key={emoji} className={styles.emojiBtn} onClick={() => handleSelect(emoji)}>
          {emoji}
        </button>
      ))}
    </>
  );

  const panel = isMobile ? (
    <div data-emoji-panel className={`${styles.panel} ${styles.panelMobile}`}>
      {emojiGrid}
    </div>
  ) : (
    <div
      data-emoji-panel
      className={`${styles.panel} ${styles.panelDesktop}`}
      style={
        {
          '--emoji-top': `${panelPos.top}px`,
          '--emoji-left': `${panelPos.left}px`,
        } as React.CSSProperties
      }
    >
      {emojiGrid}
    </div>
  );

  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={buttonRef}
        className={styles.trigger}
        onClick={(e) => {
          e.stopPropagation();
          handleToggle();
        }}
      >
        <Smile size={22} />
      </button>

      {open &&
        createPortal(
          <>
            <div
              style={{
                position: 'fixed',
                inset: 0,
                zIndex: 349,
              }}
            />
            {panel}
          </>,
          document.body
        )}
    </div>
  );
}
