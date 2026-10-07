/**
 * ============================================================
 * 元素可见性检测 Hook（useVisibility）
 * ============================================================
 * 自 client/src/components/post/PostCard.tsx 拆出（纯拆分重构，行为不变）。
 * IntersectionObserver（threshold [0.5, 0.95]，deps [] 只挂载一次）：
 * - ≥95% 完全可见：isFullyVisible（视频自动播放用）
 * - ≥50% 部分可见：isPartiallyVisible（图片轮播自动播放用；
 *   大卡片/小视口下 95% 不可达，需放宽）
 * 挂载时创建观察器并 observe，卸载时 disconnect。
 * ============================================================
 */

import { useEffect, useState, RefObject } from 'react';

export interface VisibilityState {
  isFullyVisible: boolean;
  isPartiallyVisible: boolean;
}

export function useVisibility<T extends HTMLElement>(targetRef: RefObject<T | null>): VisibilityState {
  const [isFullyVisible, setIsFullyVisible] = useState(false);
  const [isPartiallyVisible, setIsPartiallyVisible] = useState(false);

  // Intersection Observer: 检测帖子可见程度
  // - ≥95% 完全可见：视频自动播放
  // - ≥50% 部分可见：图片轮播自动播放（大卡片/小视口下 95% 不可达，需放宽）
  useEffect(() => {
    const el = targetRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        setIsPartiallyVisible(entry.isIntersecting && entry.intersectionRatio >= 0.5);
        setIsFullyVisible(entry.isIntersecting && entry.intersectionRatio >= 0.95);
      },
      { threshold: [0.5, 0.95] }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [targetRef]);

  return { isFullyVisible, isPartiallyVisible };
}
