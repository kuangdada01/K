/**
 * ============================================================
 * 可取消的关闭编排 Hook（useCancelableClose）
 * ============================================================
 * 全屏看图"单击关闭"的两阶段编排，配套 useImagePinchZoom 的
 * onSingleTap（立即）/ onSingleTapCancelled（双击窗口内撤销）：
 * - requestClose：先延迟 fadeDelayMs 再置 closing 播关闭动画（视觉仍快速响应，
 *   但双击窗口内更早到达的第二次轻点不会看到"先暗一下又弹回"的闪烁），
 *   并在双击窗口（DOUBLE_TAP_MS）外加安全余量后执行最终卸载 onClose；
 *   窗口内组件仍保持挂载且可交互，第二次轻点（构成双击）可 cancelClose 撤销。
 * - cancelClose：撤销关闭——清除卸载/动画定时器、退出 closing（瞬间回弹，
 *   不播反向淡出），随后由 useImagePinchZoom 执行双击缩放。
 * - 卸载兜底：组件提前卸载（路由切换等）时清除定时器，绝不回调 onClose。
 *
 * 供 PostMedia / ChatZoomOverlay / PrivateFolder 共用。
 * ============================================================
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { DOUBLE_TAP_MS } from './useImagePinchZoom';

/** 最终卸载的等待时长：双击窗口 + 安全余量（ms）。
 *  必须 ≥ 双击窗口，否则第二次轻点到达时组件已被卸载，双击缩放失效。 */
export const CANCELABLE_CLOSE_KEEP_MS = DOUBLE_TAP_MS + 80;

/** 关闭动画延迟启动（ms）：双击窗口内的第二次轻点通常早于该间隔到达，
 *  延迟播淡出可让双击缩放前看不到"先暗一下又弹回"的闪烁；
 *  单击关闭的视觉响应仍约 100ms 内开始（此前是 300ms 干等） */
export const CANCELABLE_CLOSE_FADE_DELAY_MS = 110;

export interface CancelableCloseApi {
  /** 是否处于关闭中（消费方据此挂 closing 类播放关闭动画） */
  closing: boolean;
  /** 启动关闭：延迟 fadeDelayMs 置 closing（双击可撤销），双击窗口过后执行 onClose（幂等） */
  requestClose: () => void;
  /** 撤销关闭：清除卸载与动画定时器并退出 closing（双击缩放路径调用） */
  cancelClose: () => void;
}

export function useCancelableClose(
  onClose: () => void,
  keepMs = CANCELABLE_CLOSE_KEEP_MS,
  fadeDelayMs = CANCELABLE_CLOSE_FADE_DELAY_MS
): CancelableCloseApi {
  const [closing, setClosing] = useState(false);
  const finalizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // onClose 每次渲染可能是新函数（如内联箭头），用 ref 保持定时器回调永远取最新值；
  // 在 effect 中同步（渲染期写 ref 会被 react-hooks/refs 规则拦截）
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  const requestClose = useCallback(() => {
    if (finalizeTimerRef.current) return; // 已在关闭流程中（含撤销前的窗口期），幂等
    // 延迟播关闭动画：双击窗口内的第二次轻点会在动画开始前撤销关闭
    if (!fadeTimerRef.current) {
      fadeTimerRef.current = setTimeout(() => {
        fadeTimerRef.current = null;
        setClosing(true);
      }, fadeDelayMs);
    }
    finalizeTimerRef.current = setTimeout(() => {
      finalizeTimerRef.current = null;
      setClosing(false);
      onCloseRef.current();
    }, keepMs);
  }, [keepMs, fadeDelayMs]);

  const cancelClose = useCallback(() => {
    if (finalizeTimerRef.current) {
      clearTimeout(finalizeTimerRef.current);
      finalizeTimerRef.current = null;
    }
    if (fadeTimerRef.current) {
      clearTimeout(fadeTimerRef.current);
      fadeTimerRef.current = null;
    }
    setClosing(false);
  }, []);

  // 卸载兜底：组件提前卸载（路由切换/父级卸载）时绝不延迟回调 onClose
  useEffect(() => {
    return () => {
      if (finalizeTimerRef.current) clearTimeout(finalizeTimerRef.current);
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    };
  }, []);

  return { closing, requestClose, cancelClose };
}
