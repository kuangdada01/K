/**
 * carouselGesture 纯函数单测（分页器手感模型）：
 * - resolveTargetIndex：位置 + 速度投影决定落点，一次最多翻一页
 * - settleDurationMs：落位时长按剩余距离自适应
 * - rubberBand / clampOffsetWithRubberBand：越界阻尼
 * - offsetFromMatrix：动画中途落指时读回当前偏移
 * - createVelocityTracker：滑动窗口平均速度
 */
import { describe, expect, it } from 'vitest';
import {
  clampOffsetWithRubberBand,
  createVelocityTracker,
  offsetFromMatrix,
  projectEndpoint,
  resolveTargetIndex,
  rubberBand,
  settleDurationMs,
  PROJECTION_MS,
  RUBBER_BAND_K,
  SETTLE_MAX_MS,
  SETTLE_MIN_MS,
  VELOCITY_WINDOW_MS,
} from './carouselGesture';

const W = 400; // 单页宽
const COUNT = 5;

const target = (offset: number, velocity: number, startIndex = 0, extra = {}) =>
  resolveTargetIndex({ offset, velocity, slideWidth: W, startIndex, count: COUNT, ...extra });

describe('resolveTargetIndex（分页器落点）', () => {
  it('慢拖不足半页 → 原地回弹', () => {
    expect(target(W * 0.2, 0)).toBe(0);
    expect(target(W * 0.49, 0)).toBe(0);
  });

  it('慢拖过半页 → 翻到下一页', () => {
    expect(target(W * 0.51, 0)).toBe(1);
    expect(target(W * 0.95, 0)).toBe(1);
  });

  it('快速轻甩：位移很小也翻页（速度投影，苹果相册手感）', () => {
    // 只拖了 40px，但松手速度 2px/ms → 投影 40 + 2*220 = 480px = 1.2 页
    expect(target(40, 2)).toBe(1);
    // 反向同理
    expect(target(-40, -2, 1)).toBe(0);
  });

  it('慢慢拖且速度近 0 时不会被投影带偏', () => {
    expect(target(40, 0.05)).toBe(0);
  });

  it('一次手势最多翻一页（极快甩动也不会跨多张）', () => {
    expect(target(W * 0.5, 20)).toBe(1);
    expect(target(W * 3.7, 20)).toBe(1);
    expect(target(-W * 3.7, -20, 4)).toBe(3);
  });

  it('边界钳制：第一张不能往前、最后一张不能往后', () => {
    expect(target(-500, -5, 0)).toBe(0);
    expect(target(W * COUNT + 500, 5, COUNT - 1)).toBe(COUNT - 1);
  });

  it('从中间页翻页：以 startIndex 为基准 ±1', () => {
    expect(target(W * 2 + W * 0.6, 0, 2)).toBe(3);
    expect(target(W * 2 - W * 0.6, 0, 2)).toBe(1);
    expect(target(W * 2, 0, 2)).toBe(2);
  });

  it('mouse 指针：任意位移即翻页（历史行为），位移过小不翻', () => {
    // 注意 offset 是「轨道绝对偏移」：停在第 1 页时基准为 W
    expect(target(W + 6, 0, 1, { alwaysFlip: true })).toBe(2);
    expect(target(W - 6, 0, 1, { alwaysFlip: true })).toBe(0);
    expect(target(W + 1, 0, 1, { alwaysFlip: true })).toBe(1);
  });

  it('退化输入不崩：页宽 0 / 页数 0', () => {
    expect(resolveTargetIndex({ offset: 100, velocity: 1, slideWidth: 0, startIndex: 2, count: 5 })).toBe(2);
    expect(resolveTargetIndex({ offset: 0, velocity: 0, slideWidth: W, startIndex: 0, count: 0 })).toBe(0);
  });
});

describe('projectEndpoint', () => {
  it('速度同向叠加，投影时长可覆盖默认值', () => {
    expect(projectEndpoint(100, 1)).toBeCloseTo(100 + PROJECTION_MS);
    expect(projectEndpoint(100, -1, 100)).toBeCloseTo(0);
  });
});

describe('settleDurationMs（按距离自适应）', () => {
  it('短距离取下限、长距离取上限，中间线性', () => {
    expect(settleDurationMs(0)).toBe(SETTLE_MIN_MS);
    expect(settleDurationMs(W * 4)).toBe(SETTLE_MAX_MS);
    const mid = settleDurationMs(200);
    expect(mid).toBeGreaterThan(SETTLE_MIN_MS);
    expect(mid).toBeLessThan(SETTLE_MAX_MS);
  });

  it('距离越大时长单调不减，且与方向无关', () => {
    expect(settleDurationMs(300)).toBeGreaterThanOrEqual(settleDurationMs(100));
    expect(settleDurationMs(-300)).toBe(settleDurationMs(300));
  });

  it('落位时长在「稳」的区间内（不抢也不拖沓）', () => {
    expect(SETTLE_MIN_MS).toBeGreaterThanOrEqual(200);
    expect(SETTLE_MAX_MS).toBeLessThanOrEqual(600);
  });
});

describe('rubberBand（越界阻尼）', () => {
  it('0 越界不位移；越界越大位移越大但趋近饱和', () => {
    expect(rubberBand(0)).toBe(0);
    expect(rubberBand(100)).toBeGreaterThan(0);
    expect(rubberBand(100)).toBeLessThan(100);
    expect(rubberBand(1000)).toBeLessThan(rubberBand(1000 + RUBBER_BAND_K));
  });

  it('负越界按 0 处理（调用方只传非负量）', () => {
    expect(rubberBand(-50)).toBe(0);
  });

  it('一整屏越界（373px）只走掉约一半，手感有明确阻尼', () => {
    const v = rubberBand(373);
    expect(v).toBeGreaterThan(373 * 0.4);
    expect(v).toBeLessThan(373 * 0.6);
  });
});

describe('clampOffsetWithRubberBand', () => {
  it('区间内原样返回', () => {
    expect(clampOffsetWithRubberBand(100, 0, 1000)).toBe(100);
    expect(clampOffsetWithRubberBand(0, 0, 1000)).toBe(0);
    expect(clampOffsetWithRubberBand(1000, 0, 1000)).toBe(1000);
  });

  it('越界时压缩但方向不变（拖到头仍有阻尼位移）', () => {
    const before = clampOffsetWithRubberBand(-200, 0, 1000);
    const after = clampOffsetWithRubberBand(1200, 0, 1000);
    expect(before).toBeLessThan(0);
    expect(before).toBeGreaterThan(-200);
    expect(after).toBeGreaterThan(1000);
    expect(after).toBeLessThan(1200);
  });
});

describe('offsetFromMatrix（动画中途读回当前偏移）', () => {
  it('解析 translate3d(-offset,0,0) 的计算矩阵', () => {
    expect(offsetFromMatrix('matrix(1, 0, 0, 1, -373.34, 0)')).toBeCloseTo(373.34);
    expect(offsetFromMatrix('matrix(1, 0, 0, 1, 0, 0)')).toBe(0);
  });

  it('none / matrix3d / 非法串返回 null（调用方保持原值）', () => {
    expect(offsetFromMatrix('none')).toBeNull();
    expect(offsetFromMatrix(undefined)).toBeNull();
    expect(offsetFromMatrix('')).toBeNull();
    expect(offsetFromMatrix('matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)')).toBeNull();
    expect(offsetFromMatrix('matrix(a, 0, 0, 1, 0, 0)')).toBeNull();
    expect(offsetFromMatrix('matrix(1, 0, 0, 1, 0)')).toBeNull();
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
    t.sample(300, 0);
    t.sample(50, 200);
    t.sample(0, 300);
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
