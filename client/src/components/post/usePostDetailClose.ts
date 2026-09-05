/**
 * ============================================================
 * 帖子详情关闭/返回生命周期（usePostDetailClose）
 * ============================================================
 * 从 PostDetail 抽出的覆盖层关闭管理：
 * - 关闭动画 + 音乐恢复（onClosing 回调）+ 路由回退兜底
 * - 嵌套 PostDetail 检测与注册（供外层返回键处理）
 * - 安卓硬件返回键 / popstate / ESC 三路关闭入口
 * - 滚轮穿透拦截（仅放行评论区内部滚动）
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import type { RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  setActiveNestedOverlay,
  getActiveNestedOverlay,
  consumeBackDispatch,
  beginBackDispatch,
} from '../../state/nestedOverlay';
import styles from './PostDetail.module.css';

export function usePostDetailClose(opts: {
  onClose?: () => void;
  zoomed: boolean;
  setZoomed: (v: boolean) => void;
  overlayRef: RefObject<HTMLDivElement | null>;
  /** 关闭动画启动时调用（主组件在此恢复音乐播放） */
  onClosing?: () => void;
}): { closing: boolean; handleClose: () => void } {
  const { onClose, zoomed, setZoomed, overlayRef, onClosing } = opts;
  const navigate = useNavigate();
  const [closing, setClosing] = useState(false);
  // 检测是否为嵌套 PostDetail（在另一个 PostDetail 的 ProfileOverlay 内部）
  const isNestedRef = useRef(false);

  // 注册/注销嵌套 PostDetail 实例，供外层 PostDetail 的返回键处理使用
  useEffect(() => {
    // 挂载后检测：当前 overlay 是否在另一个 PostDetail overlay 内部
    requestAnimationFrame(() => {
      if (overlayRef.current) {
        const parentOverlay = overlayRef.current.parentElement?.closest(`.${styles.overlay}`);
        if (parentOverlay) {
          isNestedRef.current = true;
          setActiveNestedOverlay(overlayRef.current);
        }
      }
    });
    return () => {
      if (isNestedRef.current) {
        setActiveNestedOverlay(null);
      }
    };
  }, [overlayRef]);

  const handleClose = useCallback(() => {
    setClosing(true);
    // 恢复音乐播放等组件级清理
    onClosing?.();
    setTimeout(() => {
      if (onClose) {
        onClose();
      } else {
        // 判断是否可以从历史记录返回（非刷新场景）
        if (window.history.length > 1) {
          navigate(-1);
        } else {
          navigate('/', { replace: true });
        }
      }
    }, 200);
  }, [onClose, navigate, onClosing]);

  // 安卓硬件返回键：优先关闭上层覆盖，再关闭帖子详情
  useEffect(() => {
    const handler = () => {
      // 嵌套 PostDetail（在 ProfileOverlay 内部）：跳过处理，由外层 PostDetail 管理
      if (isNestedRef.current) return;

      // 防重入：如果正在处理嵌套 PostDetail 的关闭，消费一次性标志后跳过
      if (!consumeBackDispatch()) return;

      // 如果有嵌套的 PostDetail（如从个人主页打开的帖子），先关闭其所在的 ProfileOverlay
      const nested = getActiveNestedOverlay();
      if (nested) {
        beginBackDispatch();
        const profileOverlay = nested.closest('.profile-overlay');
        if (profileOverlay) {
          const backBtn = profileOverlay.querySelector('[data-back]') as HTMLElement;
          if (backBtn) {
            backBtn.click();
            return;
          }
        }
      }

      // 如果当前 PostDetail 内部有自己的 ProfileOverlay 打开，先关闭它
      if (overlayRef.current) {
        const profileOverlay = overlayRef.current.querySelector('.profile-overlay');
        if (profileOverlay) {
          const backBtn = profileOverlay.querySelector('[data-back]') as HTMLElement;
          if (backBtn) {
            backBtn.click();
            return;
          }
        }
      }
      handleClose();
    };
    window.addEventListener('backbutton', handler);
    return () => window.removeEventListener('backbutton', handler);
  }, [onClose, handleClose, overlayRef]);

  // 锁定 body 滚动 + 阻止滚轮穿透到背景页面（仅允许评论区内部滚动）
  const wheelHandlerRef = useRef<((e: WheelEvent) => void) | null>(null);

  useEffect(() => {
    // 不锁定 body 滚动（保持滚动条始终可见）；仅拦截滚轮防止穿透滚动背景

    // 用 document 级别的 capture 阶段监听 wheel 事件
    // 在浏览器处理滚动默认动作之前拦截，确保 e.preventDefault() 有效
    const handleWheel = (e: WheelEvent) => {
      const target = e.target as HTMLElement;
      // Allow scrolling inside the emoji panel
      if (target.closest('[data-emoji-panel]')) return;

      // 移动端：详情容器本身是内容流滚动区，放行其内部滚动
      if (window.matchMedia('(max-width: 768px)').matches && overlayRef.current?.contains(target)) {
        return;
      }

      // 桌面端：仅放行评论区内部滚动（滚到边界仍拦截，防止穿透到背景页面）
      const commentsEl = overlayRef.current?.querySelector(`.${styles.comments}`);
      if (commentsEl && commentsEl.contains(target)) {
        const el = commentsEl as HTMLElement;
        const atTop = el.scrollTop <= 0 && e.deltaY < 0;
        const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1 && e.deltaY > 0;
        if (!atTop && !atBottom) return; // let comments scroll normally
      }
      // Prevent all other wheel events from scrolling the background page
      e.preventDefault();
    };

    wheelHandlerRef.current = handleWheel;
    document.addEventListener('wheel', handleWheel, { passive: false, capture: true });

    return () => {
      if (wheelHandlerRef.current) {
        document.removeEventListener('wheel', wheelHandlerRef.current, { capture: true });
        wheelHandlerRef.current = null;
      }
    };
  }, [overlayRef]);

  // ESC 键关闭（缩放时先退出缩放）
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (zoomed) {
          setZoomed(false);
        } else {
          handleClose();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [zoomed, closing, handleClose, setZoomed]);

  // Android 返回键：监听 popstate 关闭 overlay
  useEffect(() => {
    const handlePopState = () => {
      // 如果有嵌套的 PostDetail（如从个人主页打开的帖子），让嵌套层处理
      if (getActiveNestedOverlay()) return;
      if (!closing) {
        handleClose();
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [closing, onClose, handleClose]);

  return { closing, handleClose };
}
