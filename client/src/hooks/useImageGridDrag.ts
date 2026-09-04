/**
 * ============================================================
 * 图片网格拖拽排序 Hook（useImageGridDrag）
 * ============================================================
 * 重写自 CreatePost/EditPost 的旧拖拽实现（长按定时器 + FLIP 动画 +
 * portal 预览），新实现原则：
 *
 * 1. 按下即进入拖拽（pointerdown），移动时按指针位置**实时重排数组**，
 *    松手即完成——没有松手时的 reorder 提交，不可能出现重复/残留；
 * 2. 无 FLIP 动画、无拖拽 portal：图片随数组变化直接换位，
 *    被拖项加 .dragging 浮起样式作为视觉反馈；
 * 3. 纯 pointer 事件，桌面鼠标与移动端触摸统一。
 *
 * 用法：
 *   const { dragIndex, gridRefs, handlers } = useImageGridDrag(items, setItems);
 *   <div ref={el => { gridRefs.current[i] = el; }}
 *        className={gridItem + (i === dragIndex ? ' ' + draggingCls : '')}
 *        onPointerDown={e => handlers.onPointerDown(e, i)} />
 *   <div onPointerMove={handlers.onPointerMove}
 *        onPointerUp={handlers.onPointerUp}
 *        onPointerCancel={handlers.onPointerCancel} />
 * ============================================================
 */

import { useCallback, useRef, useState } from 'react';

export function useImageGridDrag<T>(
  setItems: React.Dispatch<React.SetStateAction<T[]>>
) {
  /** 格子 DOM 引用（按索引） */
  const gridRefs = useRef<(HTMLDivElement | null)[]>([]);
  /** 当前被拖拽项的索引（ref 同步值，供事件回调使用） */
  const dragIndexRef = useRef(-1);
  /** 是否处于拖拽中 */
  const draggingRef = useRef(false);
  /** 用于渲染浮起样式的拖拽索引（state） */
  const [dragIndex, setDragIndex] = useState(-1);

  /** 按下：立即进入拖拽（点击格子无其他动作，无长按计时器） */
  const onPointerDown = useCallback((e: React.PointerEvent, index: number) => {
    // 仅响应鼠标左键（触摸/笔无 button 限制）
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    draggingRef.current = true;
    dragIndexRef.current = index;
    setDragIndex(index);
  }, []);

  /** 移动：实时按指针位置交换数组（逐格交换，最终位置正确） */
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!draggingRef.current || dragIndexRef.current < 0) return;

    // 查找指针当前所在的格子（跳过被拖项自身）
    let target = -1;
    const from = dragIndexRef.current;
    gridRefs.current.forEach((el, i) => {
      if (!el || i === from) return;
      const r = el.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
        target = i;
      }
    });
    if (target < 0 || target === from) return;

    // 实时重排：把 from 处元素移到 target 处（splice 语义正确）
    setItems(prev => {
      if (from >= prev.length) return prev;
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(target, 0, item);
      return next;
    });
    dragIndexRef.current = target;
    setDragIndex(target);
  }, [setItems]);

  /** 结束拖拽：清理状态（不提交任何 reorder，数组已是最终顺序） */
  const endDrag = useCallback(() => {
    draggingRef.current = false;
    dragIndexRef.current = -1;
    setDragIndex(-1);
  }, []);

  return {
    /** 当前被拖拽索引（-1 = 未拖拽），用于渲染浮起样式 */
    dragIndex,
    /** 格子 ref 数组 */
    gridRefs,
    /** 事件处理器：onPointerDown 挂在每个格子，其余挂在容器上 */
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
    },
  };
}
