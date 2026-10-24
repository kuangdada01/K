/**
 * ============================================================
 * 聊天上下文菜单 (ChatContextMenu)
 * ============================================================
 * 长按/右键消息弹出的操作菜单（复制/引用/举报/撤回）。
 * 定位计算与历史实现一致（纯展示组件）。
 */

import { Copy, Flag, Quote, Undo2 } from 'lucide-react';
import styles from './ChatContextMenu.module.css';

export interface ChatContextMenuData {
  msgId: number;
  isSent: boolean;
  rect: DOMRect;
  /** 有正文才给「复制」：文件/图片/语音消息复制出空字符串只会让人困惑 */
  hasText: boolean;
}

interface ChatContextMenuProps {
  contextMenu: ChatContextMenuData;
  onCopy: (msgId: number) => void;
  onQuote: (msgId: number) => void;
  /** 举报（只出现在**对方发来**的消息上：自己的消息撤回就行，没有举报自己的场景） */
  onReport: (msgId: number) => void;
  onRecall: (msgId: number) => void;
}

export default function ChatContextMenu({
  contextMenu,
  onCopy,
  onQuote,
  onReport,
  onRecall,
}: ChatContextMenuProps) {
  // 宽度按实际可见项数估：基础（引用）130，复制 +50，举报 +60，撤回 +50
  const menuWidth =
    130 + (contextMenu.hasText ? 50 : 0) + (contextMenu.isSent ? 0 : 60) + (contextMenu.isSent ? 50 : 0);
  const menuHeight = 56;
  const gap = 14;
  const { rect } = contextMenu;
  let x = rect.left + rect.width / 2 - menuWidth / 2;
  let y = rect.top - menuHeight - gap;
  let arrowPos: 'top' | 'bottom' = 'bottom';
  if (x + menuWidth > window.innerWidth) x = window.innerWidth - menuWidth - 8;
  if (x < 0) x = 8;
  if (y < 0) {
    y = rect.bottom + gap;
    arrowPos = 'top';
  }
  // 角标水平位置：对准气泡中心
  const arrowX = rect.left + rect.width / 2 - x;

  return (
    <div
      className={`${styles.menu} ${arrowPos === 'top' ? styles.arrowTop : styles.arrowBottom}`}
      style={{ left: x, top: y, '--arrow-x': `${arrowX}px` } as React.CSSProperties}
      onClick={(e) => e.stopPropagation()}
    >
      {contextMenu.hasText && (
        <button className={styles.item} onClick={() => onCopy(contextMenu.msgId)}>
          <Copy size={15} />
          <span>复制</span>
        </button>
      )}
      <button className={styles.item} onClick={() => onQuote(contextMenu.msgId)}>
        <Quote size={15} />
        <span>引用</span>
      </button>
      {!contextMenu.isSent && (
        <button className={styles.item} onClick={() => onReport(contextMenu.msgId)}>
          <Flag size={15} />
          <span>举报</span>
        </button>
      )}
      {contextMenu.isSent && (
        <button className={`${styles.item} ${styles.danger}`} onClick={() => onRecall(contextMenu.msgId)}>
          <Undo2 size={15} />
          <span>撤回</span>
        </button>
      )}
    </div>
  );
}
