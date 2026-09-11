/**
 * carouselGesture 纯函数单测：
 * - decidePageFlip：松手翻页判定（位移阈值 ∪ 速度阈值；mouse 任意位移）
 * - createVelocityTracker：滑动窗口平均速度（抗单帧抖动、窗口裁剪）
 * 两个轮播 Hook（useTransformCarousel / useSwipeCarousel）共用这套判定。
 */
import { describe, expect, it } from 'vitest';
import {
  createVelocityTracker,
  decidePageFlip,
  settleDurationMs,
  FLING_MIN_DISTANCE_PX,
  FLING_VELOCITY_PX_PER_MS,
  PAGE_FLIP_THRESHOLD_RATIO,
  SLIDE_REBOUND_MS,
  SLIDE_SETTLE_MS,
  VELOCITY_WINDOW_MS,
} from './carouselGesture';

const W = 400; // 视口宽
const THRESHOLD = W * PAGE_FLIP_THRESHOLD_RATIO; // 48px

describe('decidePageFlip', () => {
  it('位移超过视口 1/8 → 翻页（方向跟随 dx 符号）', () => {
    expect(decidePageFlip({ dx: THRESHOLD + 1, viewportWidth: W, velocity: 0 })).toBe(1);
    expect(decidePageFlip({ dx: -(THRESHOLD + 1), viewportWidth: W, velocity: 0 })).toBe(-1);
  });

  it('位移刚好等于阈值不翻页（严格大于）', () => {
    expect(decidePageFlip({ dx: THRESHOLD, viewportWidth: W, velocity: 0 })).toBe(0);
  });

  it('微动且速度慢 → 回弹原地', () => {
    expect(decidePageFlip({ dx: 20, viewportWidth: W, velocity: 0.1 })).toBe(0);
  });

  it('快速甩动：位移不足 1/8 但也翻页（只要划过一点）', () => {
    expect(decidePageFlip({ dx: 20, viewportWidth: W, velocity: FLING_VELOCITY_PX_PER_MS })).toBe(1);
    expect(decidePageFlip({ dx: -20, viewportWidth: W, velocity: -FLING_VELOCITY_PX_PER_MS })).toBe(-1);
  });

  it('速度够但位移太小（按下即抬起）→ 不翻页，防误触', () => {
    expect(decidePageFlip({ dx: FLING_MIN_DISTANCE_PX - 1, viewportWidth: W, velocity: 3 })).toBe(0);
  });

  it('速度方向与位移方向矛盾时，以 dx 为准（不会反向翻页）', () => {
    // 手指最终向右侧划过阈值（dx<0），速度采样受抖动为正 → 仍回上一张
    expect(decidePageFlip({ dx: -(THRESHOLD + 5), viewportWidth: W, velocity: 2 })).toBe(-1);
  });

  it('mouse 指针：任意位移即翻页（历史行为）', () => {
    expect(decidePageFlip({ dx: 3, viewportWidth: W, velocity: 0, alwaysFlip: true })).toBe(1);
    expect(decidePageFlip({ dx: -3, viewportWidth: W, velocity: 0, alwaysFlip: true })).toBe(-1);
  });

  it('dx 为 0 不翻页（mouse 也不翻）', () => {
    expect(decidePageFlip({ dx: 0, viewportWidth: W, velocity: 5, alwaysFlip: true })).toBe(0);
  });
});

describe('createVelocityTracker', () => {
  it('样本不足（单点）→ 速度为 0', () => {
    const t = createVelocityTracker();
    t.sample(100, 0);
    expect(t.velocity()).toBe(0);
  });

  it('手指左滑（clientX 递减）→ 正速度（与「下一张」同向）', () => {
    const t = createVelocityTracker();
    t.sample(200, 0);
    t.sample(100, 100);
    // -(100-200)/100 = 1 px/ms
    expect(t.velocity()).toBeCloseTo(1);
  });

  it('手指右滑 → 负速度', () => {
    const t = createVelocityTracker();
    t.sample(100, 0);
    t.sample(200, 100);
    expect(t.velocity()).toBeCloseTo(-1);
  });

  it('只统计最近窗口内的样本（旧样本被裁掉）', () => {
    const t = createVelocityTracker(90);
    t.sample(300, 0); // 过期：200ms 前那一段不该参与
    t.sample(50, 200);
    t.sample(0, 300);
    // 窗口内只剩 (50,200) 与 (0,300)：-(0-50)/100 = 0.5
    expect(t.velocity()).toBeCloseTo(0.5);
  });

  it('至少保留两个样本（保证 dt > 0，不会除零/Infinity）', () => {
    const t = createVelocityTracker(10);
    t.sample(100, 0);
    t.sample(0, 1000);
    expect(Number.isFinite(t.velocity())).toBe(true);
    expect(t.velocity()).toBeCloseTo(0.1);
  });

  it('reset 清空样本（新手势不残留上一手势速度）', () => {
    const t = createVelocityTracker();
    t.sample(200, 0);
    t.sample(0, 100);
    expect(t.velocity()).toBeCloseTo(2);
    t.reset();
    expect(t.velocity()).toBe(0);
  });

  it('默认窗口为 VELOCITY_WINDOW_MS（松手速度只看最近 ~90ms）', () => {
    const t = createVelocityTracker();
    t.sample(400, 0);
    t.sample(300, VELOCITY_WINDOW_MS + 10);
    expect(t.velocity()).toBeCloseTo(100 / (VELOCITY_WINDOW_MS + 10));
  });
});

describe('settleDurationMs', () => {
  it('翻页用整页时长，回弹用更短时长', () => {
    expect(settleDurationMs(true)).toBe(SLIDE_SETTLE_MS);
    expect(settleDurationMs(false)).toBe(SLIDE_REBOUND_MS);
    expect(SLIDE_REBOUND_MS).toBeLessThan(SLIDE_SETTLE_MS);
    // 均短于历史值 400ms（左右滑动速率优化）
    expect(SLIDE_SETTLE_MS).toBeLessThan(400);
  });
});
