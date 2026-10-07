/**
 * postDetailOverlay 状态单测：
 * 详情页（半透明遮罩）打开期间，首页卡片需要暂停自动轮播 —— 这里的
 * 开关语义（计数而非布尔、订阅通知、不会减到负数）是它的正确性基础。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isPostDetailOverlayOpen,
  popPostDetailOverlay,
  pushPostDetailOverlay,
  resetPostDetailOverlayForTest,
  subscribePostDetailOverlay,
} from './postDetailOverlay';

beforeEach(() => {
  resetPostDetailOverlayForTest();
});

describe('postDetailOverlay', () => {
  it('初始为关闭', () => {
    expect(isPostDetailOverlayOpen()).toBe(false);
  });

  it('打开/关闭切换状态', () => {
    pushPostDetailOverlay();
    expect(isPostDetailOverlayOpen()).toBe(true);
    popPostDetailOverlay();
    expect(isPostDetailOverlayOpen()).toBe(false);
  });

  it('嵌套两层：内层关闭后仍为打开（不能用布尔）', () => {
    pushPostDetailOverlay();
    pushPostDetailOverlay();
    popPostDetailOverlay();
    expect(isPostDetailOverlayOpen()).toBe(true);
    popPostDetailOverlay();
    expect(isPostDetailOverlayOpen()).toBe(false);
  });

  it('多余 pop 不会把计数减成负数', () => {
    popPostDetailOverlay();
    popPostDetailOverlay();
    expect(isPostDetailOverlayOpen()).toBe(false);
    pushPostDetailOverlay();
    expect(isPostDetailOverlayOpen()).toBe(true);
  });

  it('订阅者在每次开关变化时收到通知', () => {
    const cb = vi.fn();
    const unsub = subscribePostDetailOverlay(cb);
    pushPostDetailOverlay();
    popPostDetailOverlay();
    expect(cb).toHaveBeenCalledTimes(2);
    unsub();
    pushPostDetailOverlay();
    expect(cb).toHaveBeenCalledTimes(2); // 已退订
  });
});
