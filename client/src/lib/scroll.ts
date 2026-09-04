/**
 * ============================================================
 * 首页滚动位置工具（lib/scroll）
 * ============================================================
 * 从 HomePage 抽出：滚动目标探测、位置读写与持久化。
 * 供 HomePage 与 Sidebar（导航前保存位置）共用，
 * 消除"组件反向依赖页面"的分层问题。
 */

import { Capacitor } from '@capacitor/core';

/** sessionStorage key for home page scroll position */
const SCROLL_CACHE_KEY = 'home_scrollY';

/**
 * 获取首页实际的滚动元素。
 * 桌面端：body 是滚动容器，返回 window。
 * 移动端（含 Capacitor 和移动端 Web）：body 已锁定不滚动，
 * .main-content 承担滚动，返回该 DOM 元素。
 */
export function getScrollTarget(): Window | HTMLElement {
  // 检测是否为移动端：Capacitor 原生 App 或屏幕宽度 ≤ 768px
  const isMobile = Capacitor.isNativePlatform() || window.innerWidth <= 768;
  if (isMobile) {
    const el = document.querySelector('.main-content') as HTMLElement | null;
    if (el) return el;
  }
  return window;
}

/** 读取当前滚动位置 */
export function readScrollY(): number {
  const target = getScrollTarget();
  return target === window ? window.scrollY : (target as HTMLElement).scrollTop;
}

/** 写入滚动位置 */
export function writeScrollY(y: number) {
  const target = getScrollTarget();
  if (target === window) {
    window.scrollTo(0, y);
  } else {
    (target as HTMLElement).scrollTop = y;
  }
}

/** 持久化保存当前滚动位置 */
export function persistScrollY(y: number) {
  try { sessionStorage.setItem(SCROLL_CACHE_KEY, String(y)); } catch {}
}

/** 读取持久化的滚动位置 */
export function loadPersistedScrollY(): number {
  try {
    const v = sessionStorage.getItem(SCROLL_CACHE_KEY);
    return v ? parseInt(v, 10) : 0;
  } catch { return 0; }
}

/**
 * Save current scroll position before navigation.
 * Called from Sidebar onClick — fires BEFORE React Router transitions,
 * which guarantees the scroll position is still the correct value.
 */
export function saveHomeScrollPosition() {
  const y = readScrollY();
  persistScrollY(y);
}
