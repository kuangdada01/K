/**
 * ============================================================
 * 前端共享工具函数
 * ============================================================
 */

export { resolveMediaUrl } from './config';

/**
 * 图片预览解码失败时的占位图（data URI）
 * 浏览器/WebView 一般解不了 HEIC/HEIF，选图后预览会破图；
 * 服务端会在上传后自动转成 JPEG，这里先用占位图兜底。
 */
export const IMAGE_PREVIEW_FALLBACK =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">` +
      `<rect width="160" height="160" rx="14" fill="#eef2ee"/>` +
      `<rect x="1" y="1" width="158" height="158" rx="13" fill="none" stroke="#d2ddd2" stroke-width="2"/>` +
      `<text x="80" y="72" text-anchor="middle" font-family="sans-serif" font-size="22" font-weight="700" fill="#55645d">HEIC</text>` +
      `<text x="80" y="96" text-anchor="middle" font-family="sans-serif" font-size="13" fill="#82948b">发布后自动转换</text>` +
      `</svg>`
  );

/**
 * 生成图片本地预览 URL（选图后立即预览用）
 * - 浏览器原生可解码的格式（jpg/png/gif/webp/avif 等）：直接返回 objectURL
 * - HEIC/HEIF：浏览器 <img> 解不了，动态加载 libheif-js（WASM）
 *   在本地转成 JPEG 再预览，选图即可见真实图片，不用等上传
 * - 任何一步失败（解码失败/环境不支持）都会回退占位图，本函数不抛错
 * 返回的 blob URL 由调用方在移除图片/组件卸载时负责 revoke。
 */
export async function fileToPreviewUrl(file: File): Promise<string> {
  const isHeic =
    file.type === 'image/heic' ||
    file.type === 'image/heif' ||
    file.type === 'image/heic-sequence' ||
    file.type === 'image/heif-sequence' ||
    /\.(heic|heif)$/i.test(file.name);

  if (!isHeic) {
    try {
      return URL.createObjectURL(file);
    } catch {
      return IMAGE_PREVIEW_FALLBACK;
    }
  }

  try {
    // 动态 import：libheif WASM（约 1.4MB）只在此刻加载，不进主包，不影响首屏体积
    // 注意：libheif 内置完整色彩管理（P3 → sRGB），比 heic2any 手动 BT.601 转换颜色准确
    const mod = (await import('libheif-js/wasm-bundle')) as unknown as {
      default?: typeof import('libheif-js/wasm-bundle');
      HeifDecoder: typeof import('libheif-js/wasm-bundle').HeifDecoder;
    };
    const libheif = mod.default ?? mod;
    const decoder = new libheif.HeifDecoder();
    const images = decoder.decode(await file.arrayBuffer());
    const image = images[0];
    if (!image) throw new Error('HEIC 无有效图像');

    // libheif 解码时已按 EXIF orientation 应用旋转，尺寸即为正确显示尺寸
    const width = image.get_width();
    const height = image.get_height();
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D 不可用');
    const imageData = ctx.createImageData(width, height);
    await new Promise<void>((resolve, reject) => {
      image.display(imageData, (displayData) => {
        if (displayData) resolve();
        else reject(new Error('HEIC 解码失败'));
      });
    });
    ctx.putImageData(imageData, 0, 0);

    // 转成 JPEG blob 预览（浏览器可解码）
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.92)
    );
    if (!blob) throw new Error('JPEG 编码失败');
    return URL.createObjectURL(blob);
  } catch (err) {
    console.error('HEIC 本地预览转换失败，回退占位图', err);
    return IMAGE_PREVIEW_FALLBACK;
  }
}

/**
 * 解析服务端时间字符串为 Date
 * - 新格式: ISO-8601 UTC（带 Z 或时区偏移，P1 迁移后新数据格式）
 * - 旧格式: 'YYYY-MM-DD HH:MM:SS'（UTC 无后缀），补 Z 解析
 * 服务端两种格式可能并存（旧数据），统一在此兼容。
 */
export function parseDbTime(dateStr: string): Date {
  if (!dateStr) return new Date();
  if (dateStr.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(dateStr)) return new Date(dateStr);
  return new Date(dateStr + 'Z');
}

/**
 * 格式化时间为相对时间（刚刚、x分钟前、x小时前等）
 * 用于帖子卡片等需要显示相对时间的场景
 *
 * @param dateStr - 服务端时间字符串
 * @returns 相对时间字符串
 */
export function formatRelativeTime(dateStr: string): string {
  const date = parseDbTime(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return '刚刚';
  if (diffMins < 60) return `${diffMins}分钟前`;
  if (diffHours < 24) return `${diffHours}小时前`;
  if (diffDays < 7) return `${diffDays}天前`;
  return date.toLocaleDateString();
}

/**
 * 格式化时间为绝对时间（日期 + 时间）
 * 用于帖子详情等需要显示具体时间的场景
 *
 * @param dateStr - ISO 格式的日期字符串
 * @returns 格式化后的日期时间字符串
 */
export function formatAbsoluteTime(dateStr: string): string {
  const date = parseDbTime(dateStr);
  return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * 格式化时间为简短格式（仅时间）
 * 用于消息列表等需要显示简短时间的场景
 *
 * @param dateStr - ISO 格式的日期字符串
 * @returns 格式化后的时间字符串
 */
export function formatShortTime(dateStr: string): string {
  const date = parseDbTime(dateStr);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * 格式化聊天时间分隔符（微信风格）
 * - 今天: "14:30"
 * - 昨天: "昨天 14:30"
 * - 本周内: "星期一 14:30"
 * - 今年内: "6月29日 14:30"
 * - 跨年: "2025年6月29日 14:30"
 *
 * @param dateStr - ISO 格式的日期字符串
 * @returns 格式化后的时间分隔符字符串
 */
export function formatTimeSeparator(dateStr: string): string {
  const date = parseDbTime(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.floor((today.getTime() - msgDate.getTime()) / 86400000);

  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (diffDays === 0) return time;
  if (diffDays === 1) return `昨天 ${time}`;
  if (diffDays < 7) {
    const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    return `${weekdays[date.getDay()]} ${time}`;
  }
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
  }
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}

/**
 * 格式化最后消息时间（智能显示）
 * 今天显示时间，昨天显示"昨天"，7天内显示星期，其他显示日期
 *
 * @param dateStr - ISO 格式的日期字符串
 * @returns 智能格式化的时间字符串
 */
export function formatLastMessageTime(dateStr: string): string {
  const date = parseDbTime(dateStr);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - date.getTime()) / 86400000);

  if (diffDays === 0) return formatShortTime(dateStr);
  if (diffDays === 1) return '昨天';
  if (diffDays < 7) return date.toLocaleDateString([], { weekday: 'short' });
  return date.toLocaleDateString();
}