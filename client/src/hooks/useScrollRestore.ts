/**
 * ============================================================
 * 滚动位置恢复 Hook（useScrollRestore）
 * ============================================================
 * 从 HomePage 抽出：带渐进重试的滚动恢复。
 * 解决图片加载导致高度不足、浏览器截断 scrollTop 的问题：
 * 最多 90 帧（约 1.5s @60fps）持续尝试，连续 5 帧稳定即提前退出。
 *
 * @param ready 信息流数据是否就绪（原语义: 缓存存在才恢复）
 */

import { useLayoutEffect } from 'react';
import { getScrollTarget, loadPersistedScrollY, readScrollY, writeScrollY } from '../lib/scroll';

export function useScrollRestore(ready: boolean): void {
  useLayoutEffect(() => {
    const restoredY = loadPersistedScrollY();
    if (!ready || restoredY <= 0) return;

    let rafId: number;
    let attempts = 0;
    let stableCount = 0;
    let lastY = -1;
    const MAX_ATTEMPTS = 90; // ~1.5s at 60fps，足以覆盖绝大多数图片加载

    const tryRestore = () => {
      const target = getScrollTarget();
      const maxScroll =
        target === window
          ? document.documentElement.scrollHeight - window.innerHeight
          : (target as HTMLElement).scrollHeight - (target as HTMLElement).clientHeight;

      if (maxScroll > 0) {
        writeScrollY(restoredY);
      }

      const actualY = readScrollY();
      // 已到达目标位置且连续 5 帧稳定 → 提前退出，避免无意义轮询
      if (Math.abs(actualY - lastY) < 2) {
        stableCount++;
      } else {
        stableCount = 0;
      }
      lastY = actualY;

      attempts++;
      if (attempts < MAX_ATTEMPTS && (stableCount < 5 || maxScroll < restoredY)) {
        rafId = requestAnimationFrame(tryRestore);
      }
    };

    rafId = requestAnimationFrame(tryRestore);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [ready]);
}
