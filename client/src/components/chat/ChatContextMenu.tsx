/**
 * ============================================================
 * 聊天上下文菜单 (ChatContextMenu)
 * ============================================================
 * 长按/右键消息弹出的操作菜单（复制/引用/撤回）。
 * 定位计算与历史实现一致（纯展示组件）。
 */

import { Copy, Quote, Undo2 } from 'lucide-react';
import styles from './ChatContextMenu.module.css';

export interface ChatContextMenuData {
  msgId: number;
  isSent: boolean;
  rect: DOMRect;
}

interface ChatContextMenuProps {
  contextMenu: ChatContextMenuData;
  onCopy: (msgId: number) => void;
  onQuote: (msgId: number) => void;
  onRecall: (msgId: number) => void;
}

export default function ChatContextMenu({ contextMenu, onCopy, onQuote, onRecall }: ChatContextMenuProps) {
  const menuWidth = contextMenu.isSent ? 180 : 130;
  const menuHeight = 56;
  const gap = 14;
  const { rect } = contextMenu;
  let x = rect.left + rect.width / 2 - menuWidth / 2;
  let y = rect.top - menuHeight - gap;
  let arrowPos: 'top' | 'bottom' = 'bottom';
  if (x + menuWidth > window.innerWidth) x = window.innerWidth - menuWidth - 8;
  if (x < 0) x = 8;
  if (y < 0) { y = rect.bottom + gap; arrowPos = 'top'; }
  // 角标水平位置：对准气泡中心
  const arrowX = rect.left + rect.width / 2 - x;

  return (
    <div
      className={`${styles.menu} ${arrowPos === 'top' ? styles.arrowTop : styles.arrowBottom}`}
      style={{ left: x, top: y, '--arrow-x': `${arrowX}px` } as React.CSSProperties}
      onClick={e => e.stopPropagation()}
    >
      <button className={styles.item} onClick={() => onCopy(contextMenu.msgId)}>
        <Copy size={15} />
        <span>复制</span>
      </button>
      <button className={styles.item} onClick={() => onQuote(contextMenu.msgId)}>
        <Quote size={15} />
        <span>引用</span>
      </button>
      {contextMenu.isSent && (
        <button className={`${styles.item} ${styles.danger}`} onClick={() => onRecall(contextMenu.msgId)}>
          <Undo2 size={15} />
          <span>撤回</span>
        </button>
      )}
    </div>
  );
}
