/**
 * ============================================================
 * 全屏图片双指缩放 Hook（useImagePinchZoom）
 * ============================================================
 * 帖子全屏看图（PostMedia zoom overlay）/聊天图片全屏
 * （ChatZoomOverlay）/私密文件夹全屏（PrivateFolder）共用：
 * - 双指捏合缩放（1x–4x，围绕捏合中点跟手缩放）
 * - 放大后单指拖动平移（边缘钳制，不露黑边）
 * - 缩回 1x 自动复位 transform，横向翻页交还轮播
 * - 手势结束后 350ms 内吞掉随后的 click（防误触关闭全屏）
 * - 手势期间视口 touch-action 临时置 none（防原生垂直滚动/页面缩放抢手势）
 *
 * 数学抽为导出纯函数（可单测），DOM 绑定为薄封装：
 * - clampZoomScale / zoomAroundMidpoint / clampZoomPan
 * ============================================================
 */

import { useCallback, useMemo, useRef } from 'react';

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

/** 捏合中点锚定后吞 click 的时间窗（ms） */
export const GESTURE_CLICK_WINDOW_MS = 350;

/** 双击判定：两次轻点间隔上限（ms） */
export const DOUBLE_TAP_MS = 300;

/** 双击判定：两次轻点允许的最大位移（px） */
export const DOUBLE_TAP_MOVE_TOLERANCE = 30;

/** 轻点过程中超过该位移（px）视为滑动，取消 tap 候选 */
export const TAP_MOVE_CANCEL_PX = 12;

/** 双击放大目标倍率（超过 MAX_ZOOM 会被钳制） */
export const DOUBLE_TAP_SCALE = 2.5;

/** 单点关闭延迟（ms）：等待双击窗口，避免单击误关 */
export const SINGLE_TAP_DELAY_MS = DOUBLE_TAP_MS;

export interface ImagePinchZoomApi {
  /** 当前缩放倍数（ref 直读，供外部判断是否放大态） */
  scaleRef: React.RefObject<number>;
  /** 是否处于放大态（scale > 1） */
  isZoomed: () => boolean;
  /** 复位到 1x（切图/关闭/重新打开时调用） */
  reset: () => void;
  /**
   * 绑定手势到视口（手势捕获 + click 吞并）与图片元素（transform 目标）。
   * getImage 惰性取当前图片元素（图片异步加载/索引变化时仍正确）。
   * opts.onSingleTap：触摸轻点（未构成双击）时回调——组件用它延迟关闭全屏
   * （桌面鼠标点击仍走元素自身 onClick，不经此回调）。
   * 返回解绑函数；viewport 为空时为 noop。
   */
  attach: (
    viewport: HTMLElement | null,
    getImage: () => HTMLElement | null,
    opts?: { onSingleTap?: () => void }
  ) => () => void;
}

/** 缩放钳制到 [min, max] */
export function clampZoomScale(scale: number, min = MIN_ZOOM, max = MAX_ZOOM): number {
  return Math.min(max, Math.max(min, scale));
}

/**
 * 捏合缩放平移量：保持"捏合起始中点下的画面点"在缩放后仍位于新中点之下。
 * 以元素中心为 transform-origin：screen = center + (p - center) * s + T
 * 由 M0 = C + (p - C)*s0 + T0 解出 p，再令 M = C + (p - C)*s + T 得 T。
 */
export function zoomAroundMidpoint(opts: {
  startScale: number;
  startTx: number;
  startTy: number;
  startMidX: number;
  startMidY: number;
  centerX: number;
  centerY: number;
  scale: number;
  midX: number;
  midY: number;
}): { tx: number; ty: number } {
  const ratio = opts.scale / opts.startScale;
  return {
    tx: opts.midX - opts.centerX - (opts.startMidX - opts.centerX - opts.startTx) * ratio,
    ty: opts.midY - opts.centerY - (opts.startMidY - opts.centerY - opts.startTy) * ratio,
  };
}

/** 平移钳制：放大后的画面必须始终盖住视口（不露出黑边）。
 *  imgW/imgH = 图片元素尺寸；viewW/viewH = 视口尺寸。
 *  图片某轴放大后仍小于视口（小图），该轴不允许平移。 */
export function clampZoomPan(
  tx: number,
  ty: number,
  scale: number,
  imgW: number,
  imgH: number,
  viewW: number,
  viewH: number
): { tx: number; ty: number } {
  const maxTx = Math.max(0, (imgW * scale - viewW) / 2);
  const maxTy = Math.max(0, (imgH * scale - viewH) / 2);
  return {
    tx: Math.min(maxTx, Math.max(-maxTx, tx)) || 0,
    ty: Math.min(maxTy, Math.max(-maxTy, ty)) || 0,
  };
}

export function useImagePinchZoom(): ImagePinchZoomApi {
  const scaleRef = useRef(1);
  const txRef = useRef(0);
  const tyRef = useRef(0);
  const lastGestureAtRef = useRef(0);

  const isZoomed = useCallback(() => scaleRef.current > 1.001, []);

  const reset = useCallback(() => {
    scaleRef.current = 1;
    txRef.current = 0;
    tyRef.current = 0;
  }, []);

  const attach = useCallback(
    (
      viewport: HTMLElement | null,
      getImage: () => HTMLElement | null,
      opts?: { onSingleTap?: () => void }
    ) => {
      if (!viewport) return () => {};

      interface PinchState {
        d0: number;
        startMidX: number;
        startMidY: number;
        startScale: number;
        startTx: number;
        startTy: number;
        centerX: number;
        centerY: number;
      }
      interface PanState {
        x0: number;
        y0: number;
        startTx: number;
        startTy: number;
      }
      let pinch: PinchState | null = null;
      let pan: PanState | null = null;
      // —— 双击/单击判定状态 ——
      let tapCandidate: { x: number; y: number } | null = null;
      let lastTap: { x: number; y: number; t: number } | null = null;
      let singleTapTimer: ReturnType<typeof setTimeout> | null = null;
      // 最近一次 touchend 时间：吞掉触摸产生的 click（双击窗口内防误关）
      let lastTouchEndAt = 0;

      /** 把当前缩放/平移写到图片 transform；1x 时清空并还原视口 touch-action */
      const apply = () => {
        const img = getImage();
        const s = scaleRef.current;
        if (s <= 1.001) {
          if (img) {
            img.style.transform = '';
            // 还原元素自身动画（入场/出场 transform 动画），否则 inline transform 被动画覆盖
            img.style.animation = '';
          }
          viewport.style.touchAction = '';
          return;
        }
        if (img) {
          img.style.transform = `translate3d(${txRef.current}px, ${tyRef.current}px, 0) scale(${s})`;
          // 放大态：暂停元素 transform 动画，避免入场/出场动画覆盖缩放
          img.style.animation = 'none';
        }
        // 放大态：禁原生垂直滚动/页面缩放，手势完全交给 JS
        viewport.style.touchAction = 'none';
      };

      /** 双击：未放大 → 以轻点为中心放大；已放大 → 缩回 1x */
      const handleDoubleTap = (x: number, y: number) => {
        const img = getImage();
        if (!img) return;
        const rect = img.getBoundingClientRect();
        const startScale = scaleRef.current;
        const targetScale = startScale > 1.001 ? 1 : DOUBLE_TAP_SCALE;
        const { tx, ty } = zoomAroundMidpoint({
          startScale,
          startTx: txRef.current,
          startTy: tyRef.current,
          startMidX: x,
          startMidY: y,
          centerX: rect.left + rect.width / 2,
          centerY: rect.top + rect.height / 2,
          scale: targetScale,
          midX: x,
          midY: y,
        });
        const clamped = clampZoomPan(
          tx,
          ty,
          targetScale,
          img.clientWidth || viewport.clientWidth || 1,
          img.clientHeight || viewport.clientHeight || 1,
          viewport.clientWidth || 1,
          viewport.clientHeight || 1
        );
        scaleRef.current = targetScale;
        txRef.current = clamped.tx;
        tyRef.current = clamped.ty;
        lastGestureAtRef.current = Date.now();
        apply();
      };

      const touchStart = (e: TouchEvent) => {
        const img = getImage();
        if (!img) return;
        if (e.touches.length >= 2) {
          const t0 = e.touches[0]!;
          const t1 = e.touches[1]!;
          const rect = img.getBoundingClientRect();
          pinch = {
            d0: Math.max(1, Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY)),
            startMidX: (t0.clientX + t1.clientX) / 2,
            startMidY: (t0.clientY + t1.clientY) / 2,
            startScale: scaleRef.current,
            startTx: txRef.current,
            startTy: tyRef.current,
            centerX: rect.left + rect.width / 2,
            centerY: rect.top + rect.height / 2,
          };
          pan = null;
          // 多指：取消轻点判定（捏合不是 tap）
          tapCandidate = null;
        } else if (e.touches.length === 1) {
          const t = e.touches[0]!;
          // 放大态单指起始：进入平移；仍记录轻点候选（位移小则双击判定有效）
          if (scaleRef.current > 1.001) {
            pan = { x0: t.clientX, y0: t.clientY, startTx: txRef.current, startTy: tyRef.current };
            pinch = null;
          }
          tapCandidate = { x: t.clientX, y: t.clientY };
        }
      };

      const touchMove = (e: TouchEvent) => {
        if (pinch && e.touches.length >= 2) {
          e.preventDefault();
          const t0 = e.touches[0]!;
          const t1 = e.touches[1]!;
          const d = Math.max(1, Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY));
          const scale = clampZoomScale(pinch.startScale * (d / pinch.d0));
          const midX = (t0.clientX + t1.clientX) / 2;
          const midY = (t0.clientY + t1.clientY) / 2;
          const { tx, ty } = zoomAroundMidpoint({ ...pinch, scale, midX, midY });
          const img = getImage();
          const clamped = clampZoomPan(
            tx,
            ty,
            scale,
            img?.clientWidth || viewport.clientWidth || 1,
            img?.clientHeight || viewport.clientHeight || 1,
            viewport.clientWidth || 1,
            viewport.clientHeight || 1
          );
          scaleRef.current = scale;
          txRef.current = clamped.tx;
          tyRef.current = clamped.ty;
          lastGestureAtRef.current = Date.now();
          apply();
        } else if (pan && e.touches.length === 1 && scaleRef.current > 1.001) {
          e.preventDefault();
          const t = e.touches[0]!;
          const img = getImage();
          const clamped = clampZoomPan(
            pan.startTx + (t.clientX - pan.x0),
            pan.startTy + (t.clientY - pan.y0),
            scaleRef.current,
            img?.clientWidth || viewport.clientWidth || 1,
            img?.clientHeight || viewport.clientHeight || 1,
            viewport.clientWidth || 1,
            viewport.clientHeight || 1
          );
          txRef.current = clamped.tx;
          tyRef.current = clamped.ty;
          lastGestureAtRef.current = Date.now();
          apply();
        }
        // 单指位移超过阈值 → 不是轻点（滑动/平移），取消 tap 候选
        if (e.touches.length === 1 && tapCandidate) {
          const t = e.touches[0]!;
          if (Math.hypot(t.clientX - tapCandidate.x, t.clientY - tapCandidate.y) > TAP_MOVE_CANCEL_PX) {
            tapCandidate = null;
          }
        }
      };

      const touchEnd = (e: TouchEvent) => {
        lastTouchEndAt = Date.now();
        if (pinch) {
          if (e.touches.length >= 2) return;
          // 双指抬起一指：仍放大则转为单指平移
          if (e.touches.length === 1 && scaleRef.current > 1.001) {
            const t = e.touches[0]!;
            pan = { x0: t.clientX, y0: t.clientY, startTx: txRef.current, startTy: tyRef.current };
          } else {
            pan = null;
          }
          pinch = null;
          tapCandidate = null;
          if (scaleRef.current <= 1.001) {
            scaleRef.current = 1;
            txRef.current = 0;
            tyRef.current = 0;
          }
          apply();
          return;
        }
        if (pan && e.touches.length === 0) {
          pan = null;
        }
        // —— 轻点判定（单指、无捏合、未位移成滑动）——
        if (e.touches.length === 0 && tapCandidate) {
          const { x, y } = tapCandidate;
          tapCandidate = null;
          if (lastTap && Date.now() - lastTap.t <= DOUBLE_TAP_MS) {
            // 双击：取消待执行的单击关闭，缩放/复位，吞掉随后 click
            if (singleTapTimer) {
              clearTimeout(singleTapTimer);
              singleTapTimer = null;
            }
            lastTap = null;
            lastGestureAtRef.current = Date.now();
            handleDoubleTap(x, y);
          } else {
            lastTap = { x, y, t: Date.now() };
            // 单击：延迟执行（等待双击窗口），期间第二次轻点会取消
            if (singleTapTimer) clearTimeout(singleTapTimer);
            singleTapTimer = setTimeout(() => {
              singleTapTimer = null;
              lastTap = null;
              opts?.onSingleTap?.();
            }, SINGLE_TAP_DELAY_MS);
          }
        }
      };

      // 触摸被系统取消（来电/系统手势接管等）：清理状态，绝不触发单击关闭
      const touchCancel = () => {
        lastTouchEndAt = Date.now();
        pinch = null;
        pan = null;
        tapCandidate = null;
        if (singleTapTimer) {
          clearTimeout(singleTapTimer);
          singleTapTimer = null;
        }
        apply();
      };

      // 手势结束后浏览器可能补发 click（松手即关闭全屏），capture 阶段吞掉；
      // 触摸轻点后的 click 也在双击窗口内吞掉（防第一次轻点的 click 提前关闭，
      // 关闭统一走 onSingleTap 延迟回调）；但按钮等交互元素始终放行
      const clickCapture = (e: Event) => {
        const target = e.target as HTMLElement | null;
        if (target?.closest('button, a, input, select, textarea, [role="button"]')) return;
        const now = Date.now();
        const afterGesture = now - lastGestureAtRef.current < GESTURE_CLICK_WINDOW_MS;
        const afterTouch = now - lastTouchEndAt < DOUBLE_TAP_MS + 50;
        if (!afterGesture && !afterTouch) return;
        e.stopPropagation();
        e.preventDefault();
      };

      viewport.addEventListener('touchstart', touchStart, { passive: false });
      viewport.addEventListener('touchmove', touchMove, { passive: false });
      viewport.addEventListener('touchend', touchEnd);
      viewport.addEventListener('touchcancel', touchCancel);
      viewport.addEventListener('click', clickCapture, true);

      return () => {
        viewport.removeEventListener('touchstart', touchStart);
        viewport.removeEventListener('touchmove', touchMove);
        viewport.removeEventListener('touchend', touchEnd);
        viewport.removeEventListener('touchcancel', touchCancel);
        viewport.removeEventListener('click', clickCapture, true);
        if (singleTapTimer) {
          clearTimeout(singleTapTimer);
          singleTapTimer = null;
        }
        pinch = null;
        pan = null;
        tapCandidate = null;
        lastTap = null;
      };
    },
    []
  );

  return useMemo(() => ({ scaleRef, isZoomed, reset, attach }), [isZoomed, reset, attach]);
}
