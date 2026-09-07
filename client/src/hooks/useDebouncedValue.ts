/**
 * ============================================================
 * 防抖值 Hook（useDebouncedValue）
 * ============================================================
 * 通用防抖：value 停止变化 delayMs 后才会返回新值（期间返回上一次值，
 * 首次渲染直接返回初始值）。ExplorePage 的搜索防抖改用它（500ms 延迟
 * 不变，仅换实现方式）。
 * ============================================================
 */

import { useEffect, useState } from 'react';

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
