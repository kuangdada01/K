/**
 * 滚动工具测试（lib/scroll）
 * 桌面端路径（window 为滚动容器）与位置持久化；移动端路径只验证目标探测
 * （jsdom 无布局，scrollTop 读写不回显，不做断言）
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { getScrollTarget, loadPersistedScrollY, persistScrollY, readScrollY, writeScrollY } from './scroll';

afterEach(() => {
  document.querySelector('.main-content')?.remove();
  vi.restoreAllMocks();
});

describe('getScrollTarget', () => {
  it('桌面端（宽度 > 768 且无 .main-content）返回 window', () => {
    expect(getScrollTarget()).toBe(window);
  });

  it('移动端宽度下存在 .main-content 时返回该元素', () => {
    const el = document.createElement('div');
    el.className = 'main-content';
    document.body.appendChild(el);
    const original = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { value: 500, configurable: true });
    try {
      expect(getScrollTarget()).toBe(el);
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: original, configurable: true });
    }
  });
});

describe('persistScrollY / loadPersistedScrollY', () => {
  it('持久化后读回同一位置', () => {
    persistScrollY(1234);
    expect(loadPersistedScrollY()).toBe(1234);
  });

  it('未保存时返回 0', () => {
    expect(loadPersistedScrollY()).toBe(0);
  });
});

describe('桌面端读写（window 为滚动容器）', () => {
  it('readScrollY 读取 window.scrollY', () => {
    expect(readScrollY()).toBe(window.scrollY);
  });

  it('writeScrollY 调用 window.scrollTo', () => {
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    writeScrollY(88);
    expect(scrollTo).toHaveBeenCalledWith(0, 88);
  });
});
