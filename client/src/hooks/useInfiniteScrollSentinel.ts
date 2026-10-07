/**
 * ============================================================
 * 无限滚动哨兵 Hook（useInfiniteScrollSentinel）
 * ============================================================
 * 自 ExplorePage / HomePage 内联的 IntersectionObserver 哨兵逻辑拆出
 * （纯搬移，行为不变；本次仅 ExplorePage 接线，HomePage 后续接入）。
 *
 * 哨兵元素进入视口（threshold 0.1）且 hasMore && !loading 时触发
 * onLoadMore()；ref / hasMore / loading / onLoadMore 变化时重建
 * observer（与两位调用方原 effect 的依赖语义一致）。
 * ============================================================
 */

import { useEffect } from 'react';
import type { RefObject } from 'react';

export interface UseInfiniteScrollSentinelOptions {
  /** 是否还有更多页（false 时即使可见也不触发） */
  hasMore: boolean;
  /** 请求进行中（true 时暂停触发，避免连续翻页） */
  loading: boolean;
  /** 加载更多回调（如 loadPosts(page + 1, keyword, true)） */
  onLoadMore: () => void;
}

export function useInfiniteScrollSentinel(
  ref: RefObject<HTMLDivElement | null>,
  { hasMore, loading, onLoadMore }: UseInfiniteScrollSentinelOptions
): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasMore && !loading) {
          onLoadMore();
        }
      },
      { threshold: 0.1 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, hasMore, loading, onLoadMore]);
}
