/**
 * ============================================================
 * 红心 SVG 填充 Hook（useHeartFill）
 * ============================================================
 * 自 PostCard / PostDetail 的"直接操作 SVG DOM"effect 拆出（纯搬移，
 * 行为不变）：liked 变化时读取 CSS 变量 --danger 的实际值，直接写
 * SVG presentation attribute（fill/stroke）+ 强制重绘，绕过 React 渲染。
 * ============================================================
 */

import { useEffect } from 'react';
import type { RefObject } from 'react';

export function useHeartFill(heartRef: RefObject<SVGSVGElement | null>, liked: boolean): void {
  useEffect(() => {
    const svg = heartRef.current;
    if (!svg) return;
    const path = svg.querySelector('path');
    if (!path) return;
    // SVG presentation attribute 不支持 var()，需读取 CSS 变量实际值
    const dangerColor =
      getComputedStyle(document.documentElement).getPropertyValue('--danger').trim() || '#ed4956';
    const c = liked ? dangerColor : 'none';
    const s = liked ? dangerColor : 'currentColor';
    path.setAttribute('fill', c);
    path.setAttribute('stroke', s);
    svg.setAttribute('fill', c);
    svg.setAttribute('stroke', s);
    // 强制重绘
    void svg.getBoundingClientRect();
  }, [liked, heartRef]);
}
