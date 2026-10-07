/**
 * ============================================================
 * 上下文菜单 + 图片缩放 Hook（features/messages/hooks）
 * ============================================================
 * 自 Messages.tsx 拆出：长按（500ms）/右键触发上下文菜单、
 * 点击/滚动关闭菜单。图片缩放 overlay 的关闭动画由
 * ChatZoomOverlay 内部编排（useCancelableClose），此处只负责
 * 卸载时机（zoomImage 置 null）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatContextMenuData } from '../../../components/chat/ChatContextMenu';
import type { Message } from '../../../types';

export function useContextMenu(userId: number | undefined) {
  const [contextMenu, setContextMenu] = useState<ChatContextMenuData | null>(null);
  const [zoomImage, setZoomImage] = useState<string | null>(null);
  // 长按触发（移动端）
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 关闭上下文菜单（点击任意处 / 滚动）
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [contextMenu]);

  // 卸载清理长按定时器（防卸载后 setState）
  useEffect(() => {
    return () => {
      if (longPressTimer.current) {
        clearTimeout(longPressTimer.current);
        longPressTimer.current = null;
      }
    };
  }, []);

  const handleTouchStart = useCallback(
    (e: React.TouchEvent, msg: Message) => {
      const target = e.currentTarget;
      longPressTimer.current = setTimeout(() => {
        const isSent = msg.sender_id === userId;
        setContextMenu({ msgId: msg.id, isSent, rect: target.getBoundingClientRect() });
      }, 500);
    },
    [userId]
  );

  const handleTouchEnd = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const handleTouchMove = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  // 右键触发（Web 端）
  const handleContextMenu = useCallback(
    (e: React.MouseEvent, msg: Message) => {
      e.preventDefault();
      const isSent = msg.sender_id === userId;
      setContextMenu({ msgId: msg.id, isSent, rect: e.currentTarget.getBoundingClientRect() });
    },
    [userId]
  );

  // 图片缩放 overlay 关闭动画播完后的最终卸载（动画编排在 ChatZoomOverlay 内部）
  const closeZoom = useCallback(() => setZoomImage(null), []);

  const closeMenu = useCallback(() => setContextMenu(null), []);

  return {
    contextMenu,
    zoomImage,
    setZoomImage,
    closeZoom,
    closeMenu,
    handleTouchStart,
    handleTouchEnd,
    handleTouchMove,
    handleContextMenu,
  };
}
