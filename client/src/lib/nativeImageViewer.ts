/**
 * ============================================================
 * 原生图片查看器桥接（nativeImageViewer）
 * ============================================================
 * Capacitor 环境下优先走**原生查看器**（ViewPager2 + 原生缩放手势 +
 * 下拉关闭 + 缩略图 Hero 转场），这是微信朋友圈/酷安/系统相册那一套；
 * 浏览器/桌面或插件不可用时返回 null，调用方回退到现有 Web 查看器。
 *
 * 用法：
 *   const native = await openNativeViewer({ images, index, headers, rect });
 *   if (!native) { 走 Web 覆盖层 }
 *   else 用 native.index 同步自己的状态（用户可能在原生里翻过页）
 * ============================================================
 */

import { Capacitor, registerPlugin } from '@capacitor/core';

export interface NativeViewerRect {
  /** 物理像素（**不是** CSS px：已乘 devicePixelRatio，原生侧直接用） */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OpenNativeViewerOptions {
  /** 图片地址（已 resolve 成绝对地址） */
  images: string[];
  index: number;
  /** 需要鉴权的图片（/api/...）带上 Authorization 等请求头 */
  headers?: Record<string, string>;
  /** 被点缩略图的屏幕矩形（物理像素）——原生侧据此做 Hero 放大进入 */
  rect?: NativeViewerRect;
}

export interface NativeViewerResult {
  /** 关闭时停留的索引；-1 表示被主动 close（无有效索引） */
  index: number;
}

interface NativeImageViewerPluginApi {
  open(options: OpenNativeViewerOptions): Promise<NativeViewerResult>;
  close(): Promise<void>;
}

const NativeImageViewer = registerPlugin<NativeImageViewerPluginApi>('NativeImageViewer');

/** 是否可用：仅原生 Android 且插件已注册（网页端恒为 false） */
export function isNativeViewerAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('NativeImageViewer');
}

/**
 * 元素 → **物理像素**矩形（Hero 用）。
 *
 * 为什么在这里换算而不是交给原生：原生侧要用只能靠 `WebView.getScale()` 猜
 * 缩放比（语义含糊，取到异常值就表现为「从错误位置放大」）；网页层
 * `devicePixelRatio` 是确定的。App 里页面缩放已关闭（setSupportZoom(false)），
 * 因此 CSS px × DPR 就是屏幕物理像素，精确无歧义。
 *
 * 应急开关：localStorage 置 `k_viewer_hero=off` 可关掉 Hero（退化为淡入），
 * 便于真机上快速区分「是 Hero 的问题还是查看器本身的问题」。
 */
export function rectOf(el: Element | null): NativeViewerRect | undefined {
  if (!el) return undefined;
  try {
    if (localStorage.getItem('k_viewer_hero') === 'off') return undefined;
  } catch {
    // localStorage 不可用（隐私模式等）：照常返回
  }
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return undefined;
  const dpr = window.devicePixelRatio || 1;
  return { x: r.left * dpr, y: r.top * dpr, width: r.width * dpr, height: r.height * dpr };
}

/**
 * 打开原生查看器。不可用时返回 null（调用方回退 Web 查看器）。
 * 关闭（返回键/关闭按钮/下拉）后 resolve，带最终索引。
 */
export async function openNativeViewer(options: OpenNativeViewerOptions): Promise<NativeViewerResult | null> {
  if (!isNativeViewerAvailable()) return null;
  try {
    return await NativeImageViewer.open(options);
  } catch {
    // 原生侧异常（Activity 启动失败等）不应让「看图」整个失效 → 回退 Web
    return null;
  }
}

/** 关闭原生查看器（若正开着） */
export async function closeNativeViewer(): Promise<void> {
  if (!isNativeViewerAvailable()) return;
  try {
    await NativeImageViewer.close();
  } catch {
    // 忽略：没有打开中的查看器
  }
}
