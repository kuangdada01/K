/**
 * useImagePinchZoom 纯函数数学单测：
 * clampZoomScale / zoomAroundMidpoint / clampZoomPan / parseZoomMatrix
 * 双击语义：以轻点为锚（起点中点 = 终点中点 = 轻点）复用 zoomAroundMidpoint
 */
import { describe, expect, it } from 'vitest';
import {
  clampZoomScale,
  zoomAroundMidpoint,
  clampZoomPan,
  parseZoomMatrix,
  MIN_ZOOM,
  MAX_ZOOM,
  DOUBLE_TAP_SCALE,
  DOUBLE_TAP_ZOOM_MS,
  DOUBLE_TAP_ZOOM_EASING,
} from './useImagePinchZoom';

describe('clampZoomScale', () => {
  it('限制在 [1, 4] 区间', () => {
    expect(clampZoomScale(0.5)).toBe(MIN_ZOOM);
    expect(clampZoomScale(1)).toBe(1);
    expect(clampZoomScale(2)).toBe(2);
    expect(clampZoomScale(6)).toBe(MAX_ZOOM);
  });

  it('支持自定义上下限', () => {
    expect(clampZoomScale(5, 1, 3)).toBe(3);
    expect(clampZoomScale(0.1, 1, 3)).toBe(1);
  });
});

describe('zoomAroundMidpoint', () => {
  const base = {
    startScale: 1,
    startTx: 0,
    startTy: 0,
    startMidX: 120,
    startMidY: 130,
    centerX: 100,
    centerY: 100,
  };

  it('缩放但不移动中点时，中点锚定不变（屏幕点跟随）', () => {
    const { tx, ty } = zoomAroundMidpoint({ ...base, scale: 2, midX: 120, midY: 130 });
    // 画面点 p = (M0 - C - T0)/s0 = (20, 30)；缩放后要满足 C + p*s + T = M
    // => T = M - C - p*s = (120,130) - (100,100) - (40,60) = (-20,-30)
    expect(tx).toBeCloseTo(-20);
    expect(ty).toBeCloseTo(-30);
  });

  it('缩放且中点移动时，中点下的画面点仍跟随新中点', () => {
    const { tx, ty } = zoomAroundMidpoint({ ...base, scale: 2, midX: 140, midY: 150 });
    // p = (20,30)；T = M - C - p*s = (140,150) - (100,100) - (40,60) = (0,-10)
    expect(tx).toBeCloseTo(0);
    expect(ty).toBeCloseTo(-10);
  });

  it('从放大态捏合（s0=2）继续放大到 3，锚定连续', () => {
    const { tx, ty } = zoomAroundMidpoint({
      startScale: 2,
      startTx: -20,
      startTy: -30,
      startMidX: 120,
      startMidY: 130,
      centerX: 100,
      centerY: 100,
      scale: 3,
      midX: 120,
      midY: 130,
    });
    // 缩放前 p = (M0 - C - T0)/s0 = (20,30)；缩放后 C + p*3 + T = (120,130)
    // => T = (120,130) - (100,100) - (60,90) = (-40,-60)
    expect(tx).toBeCloseTo(-40);
    expect(ty).toBeCloseTo(-60);
  });

  it('缩小回 1x 时回到原点', () => {
    const { tx, ty } = zoomAroundMidpoint({ ...base, scale: 1, midX: 120, midY: 130 });
    expect(tx).toBeCloseTo(0);
    expect(ty).toBeCloseTo(0);
  });
});

describe('双击放大（以轻点为锚）', () => {
  const center = { centerX: 100, centerY: 100 };
  const tap = { startMidX: 120, startMidY: 130, midX: 120, midY: 130 };
  const from1x = { startScale: 1, startTx: 0, startTy: 0 };

  it('1x 双击放大到 DOUBLE_TAP_SCALE，轻点下的画面点保持不动', () => {
    const { tx, ty } = zoomAroundMidpoint({ ...from1x, ...tap, ...center, scale: DOUBLE_TAP_SCALE });
    // p = (M - C - T0)/s0 = (20, 30)；缩放后 C + p*s + T = M
    // => T = M - C - p*s = (20,30) - (50,75) = (-30,-45)
    expect(tx).toBeCloseTo(-30);
    expect(ty).toBeCloseTo(-45);
    expect(DOUBLE_TAP_SCALE).toBeLessThanOrEqual(MAX_ZOOM);
  });

  it('轻点偏离中心时，放大后轻点仍锚定（左上方轻点）', () => {
    const leftTap = { startMidX: 40, startMidY: 40, midX: 40, midY: 40 };
    const { tx, ty } = zoomAroundMidpoint({ ...from1x, ...leftTap, ...center, scale: DOUBLE_TAP_SCALE });
    // p = (40-100, 40-100) = (-60,-60)；T = M - C - p*s = (-60,-60) - (-150,-150) = (90,90)
    expect(tx).toBeCloseTo(90);
    expect(ty).toBeCloseTo(90);
    // 放大后该点应仍映射到轻点：C + p*s + T = (100,100)+(-150,-150)+(90,90) = (40,40) ✓
  });

  it('放大态双击缩回 1x：平移归零', () => {
    const fromZoomed = { startScale: 2.5, startTx: -30, startTy: -45 };
    const { tx, ty } = zoomAroundMidpoint({ ...fromZoomed, ...tap, ...center, scale: 1 });
    expect(tx).toBeCloseTo(0);
    expect(ty).toBeCloseTo(0);
  });
});

describe('parseZoomMatrix（动画中途读回当前帧）', () => {
  it('解析 translate3d + scale 的计算矩阵（matrix(s,0,0,s,tx,ty)）', () => {
    expect(parseZoomMatrix('matrix(2.5, 0, 0, 2.5, -30, -45)')).toEqual({
      scale: 2.5,
      tx: -30,
      ty: -45,
    });
  });

  it('1x 单位矩阵解析为 scale=1 且无平移', () => {
    expect(parseZoomMatrix('matrix(1, 0, 0, 1, 0, 0)')).toEqual({ scale: 1, tx: 0, ty: 0 });
  });

  it('基础样式 none / undefined 返回 null（调用方保持原值）', () => {
    expect(parseZoomMatrix('none')).toBeNull();
    expect(parseZoomMatrix(undefined)).toBeNull();
    expect(parseZoomMatrix('')).toBeNull();
  });

  it('matrix3d / 非矩阵串 / NaN 一律返回 null（不猜）', () => {
    expect(parseZoomMatrix('matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)')).toBeNull();
    expect(parseZoomMatrix('translate3d(10px, 20px, 0)')).toBeNull();
    expect(parseZoomMatrix('matrix(1, 0, 0, 1, 0)')).toBeNull();
    expect(parseZoomMatrix('matrix(a, 0, 0, 1, 0, 0)')).toBeNull();
  });

  it('带斜切/浮点误差时用 hypot 求缩放', () => {
    const r = parseZoomMatrix('matrix(3, 0, 0, 3.0000001, 12, 8)');
    expect(r?.scale).toBeCloseTo(3, 5);
    expect(r?.tx).toBe(12);
    expect(r?.ty).toBe(8);
  });
});

describe('双击缩放手感参数', () => {
  it('时长比原来的 180ms 更从容（不再起步即满速/硬着陆）', () => {
    expect(DOUBLE_TAP_ZOOM_MS).toBeGreaterThan(180);
    expect(DOUBLE_TAP_ZOOM_MS).toBeLessThanOrEqual(400);
  });

  it('缓动不再是「前 20% 时间吃掉大半位移」的 easeOutQuint', () => {
    expect(DOUBLE_TAP_ZOOM_EASING).toBe('cubic-bezier(0.32, 0.72, 0, 1)');
    expect(DOUBLE_TAP_ZOOM_EASING).not.toContain('0.22, 1, 0.36, 1');
  });
});

describe('clampZoomPan', () => {
  it('1x 时不允许平移', () => {
    expect(clampZoomPan(100, -50, 1, 300, 200, 300, 200)).toEqual({ tx: 0, ty: 0 });
  });

  it('2x 时平移限制在 ±((imgW*s - viewW)/2) 内（不露黑边）', () => {
    // 图 300x200、视口 300x200、2x → 画面 600x400，最多平移 150/100
    expect(clampZoomPan(999, 0, 2, 300, 200, 300, 200)).toEqual({ tx: 150, ty: 0 });
    expect(clampZoomPan(-999, -999, 2, 300, 200, 300, 200)).toEqual({ tx: -150, ty: -100 });
  });

  it('4x 时平移范围更大', () => {
    expect(clampZoomPan(999, 999, 4, 300, 200, 300, 200)).toEqual({ tx: 450, ty: 300 });
  });

  it('图片小于视口时（小图放大），不允许平移出视口', () => {
    // 图 200x150、视口 300x200：2x 后 400x300，超出视口 100/100 → 每侧最多 50
    expect(clampZoomPan(999, 999, 2, 200, 150, 300, 200)).toEqual({ tx: 50, ty: 50 });
    // 图 100x100、视口 300x200：3x 后 300x300 横向刚好、纵向超出 50
    expect(clampZoomPan(999, 999, 3, 100, 100, 300, 200)).toEqual({ tx: 0, ty: 50 });
    // 图 100x100、视口 300x200：2x 后 200x200 两轴都不超出 → 不允许平移
    expect(clampZoomPan(50, 50, 2, 100, 100, 300, 200)).toEqual({ tx: 0, ty: 0 });
  });

  it('范围内的平移原样保留', () => {
    expect(clampZoomPan(30, -20, 2, 300, 200, 300, 200)).toEqual({ tx: 30, ty: -20 });
  });
});
