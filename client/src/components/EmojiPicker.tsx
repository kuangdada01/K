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
 * ============================================================
 */

import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Smile } from 'lucide-react';

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

  // 桌面端: 400x350 弹窗，靠近图标显示
  const desktopPanel = (
    <div
      data-emoji-panel
      style={{
        position: 'fixed',
        top: panelPos.top,
        left: panelPos.left,
        width: 320,
        height: 324,
        background: 'var(--bg-primary)',
        border: '1px solid var(--border-color)',
        borderRadius: 12,
        padding: '8px 12px',
        display: 'grid',
        gridTemplateColumns: 'repeat(7, 1fr)',
        gap: 1,
        justifyContent: 'center',
        alignContent: 'start',
        zIndex: 350,
        boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
        overflowY: 'scroll',
        overflowX: 'hidden',
      }}
    >
      {EMOJI_LIST.map((emoji) => (
        <button
          key={emoji}
          onClick={() => handleSelect(emoji)}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: 22,
            padding: 4,
            borderRadius: 6,
            transition: 'background 0.1s',
            lineHeight: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          onMouseOver={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
          onMouseOut={(e) => (e.currentTarget.style.background = 'none')}
        >
          {emoji}
        </button>
      ))}
    </div>
  );

  // 移动端: 固定在屏幕底部
  const mobilePanel = (
    <div
      data-emoji-panel
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        background: 'var(--bg-primary)',
        border: '1px solid var(--border-color)',
        borderRadius: '12px 12px 0 0',
        padding: 12,
        display: 'grid',
        gridTemplateColumns: 'repeat(8, 1fr)',
        gap: 4,
        justifyContent: 'center',
        zIndex: 350,
        boxShadow: '0 -4px 16px rgba(0,0,0,0.12)',
        maxHeight: 240,
        overflowY: 'auto',
        overflowX: 'hidden',
      }}
    >
      {EMOJI_LIST.map((emoji) => (
        <button
          key={emoji}
          onClick={() => handleSelect(emoji)}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: 22,
            padding: 4,
            borderRadius: 6,
            transition: 'background 0.1s',
            lineHeight: 1,
          }}
          onMouseOver={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
          onMouseOut={(e) => (e.currentTarget.style.background = 'none')}
        >
          {emoji}
        </button>
      ))}
    </div>
  );

  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={buttonRef}
        onClick={(e) => {
          e.stopPropagation();
          handleToggle();
        }}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: 4,
          color: 'var(--text-secondary)',
          display: 'flex',
          alignItems: 'center',
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
            {isMobile ? mobilePanel : desktopPanel}
          </>,
          document.body
        )}
    </div>
  );
}
