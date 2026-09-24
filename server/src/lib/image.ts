/**
 * ============================================================
 * 图片处理工具（lib/image）
 * ============================================================
 * 图片 URL 解析、上传类型校验、压缩/转码收敛于此。
 * （自 utils.ts 拆分而来，行为保持不变）
 */

import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import { logger } from './logger';
import { convertHeicInWorker } from './heicPool';
import { parseImageUrlArray } from './file';

/**
 * 解析帖子图片URL（JSON字符串 → 数组）
 * 兼容旧格式（单个URL字符串）和新格式（JSON数组）
 *
 * @param imageUrl - 数据库中存储的 image_url 字段
 * @returns 图片URL数组
 */
export function parseImageUrls(imageUrl: string): string[] {
  return parseImageUrlArray(imageUrl);
}

/**
 * 为帖子对象添加 images 数组字段
 * 不修改原对象，返回新对象
 *
 * @param post - 数据库查询返回的帖子对象
 * @returns 添加了 images 字段的新对象
 */
export function withImages<T extends { image_url: string }>(
  post: T | null
): (T & { images: string[] }) | null {
  if (!post) return null;
  return { ...post, images: parseImageUrls(post.image_url) };
}

/** 图片扩展名白名单（锚定匹配，含点号；svg/html 等一律排除；heic/heif 会在压缩时转成 jpg；avif 由 sharp 原生解码） */
export const IMAGE_EXT_RE = /^\.(jpe?g|png|gif|webp|avif|heic|heif)$/;

/** 图片 mimetype 白名单（锚定匹配；客户端可伪造 mimetype，必须与扩展名同时满足） */
export const IMAGE_MIME_RE = /^image\/(jpeg|png|gif|webp|avif|heic|heif)$/;

/**
 * Multer 图片文件过滤器
 * 仅允许 jpg/png/gif/webp/avif/heic/heif，且扩展名与 mimetype 必须同时命中白名单
 * （两者均可被客户端伪造，双校验确保落盘文件名后缀一定是安全图片类型）
 */
export function imageFileFilter(
  _req: Express.Request,
  file: Express.Multer.File,
  cb: (error: Error | null, acceptFile?: boolean) => void
) {
  const extOk = IMAGE_EXT_RE.test(path.extname(file.originalname).toLowerCase());
  const mimeOk = IMAGE_MIME_RE.test(file.mimetype);
  if (extOk && mimeOk) {
    cb(null, true);
  } else {
    cb(new Error('Only image files (jpg, png, gif, webp, avif, heic, heif) are allowed'));
  }
}

/**
 * 压缩/限制尺寸图片，返回处理后的最终文件路径
 * - 按 EXIF 自动旋转
 * - 最长边限制 maxWidth（不放大原图）
 * - **`square: true` 时输出正方形头像**（取 maxWidth × maxWidth，居中裁切）
 * - JPEG/WebP/PNG 重编码压缩；GIF 动图跳过（保留动画）
 * - HEIC/HEIF：先解码转成 JPEG 再走压缩，返回 .jpg 路径，原始 heic 删除
 *   （sharp 预编译包未内置 libde265，解不了 iPhone 的 HEVC 编码，
 *   由 heic-convert(WASM) 兜底；转换失败会抛出，避免存下浏览器打不开的 heic）
 * 压缩失败时不影响文件本身（非致命错误，沿用原文件）
 */
export async function compressImage(
  filePath: string,
  options: { maxWidth?: number; quality?: number; square?: boolean } = {}
): Promise<string> {
  const { maxWidth = 1920, quality = 80, square = false } = options;
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.gif') return filePath;

  // HEIC/HEIF → JPEG：先转码（WASM 兜底）再进下面的 sharp 压缩管线
  if (ext === '.heic' || ext === '.heif') {
    filePath = await convertHeicToJpeg(filePath);
  }

  // AVIF 重编码为 JPEG 后必须改扩展名，否则内容 JPEG、后缀 avif 会导致 MIME 错乱
  const outJpeg = ext === '.avif';
  const targetPath = outJpeg ? filePath.replace(/\.avif$/i, '.jpg') : filePath;

  try {
    const tmpPath = `${targetPath}.tmp-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    /**
     * `rotate()` 必须在 `resize()` **之前**：EXIF 里的方向信息要先落到像素上，
     * 否则竖拍的照片会先按"横着的原始像素"裁切、再被转正 —— 头像会缺一块。
     */
    const rotated = sharp(filePath).rotate();
    /**
     * 正方形模式下的**目标边长**：`min(maxWidth, 短边)`。
     *
     * 这一步同时满足两个约束：
     *  · **绝不放大小图** —— 短边只有 200px 的图产出 200×200，而不是被拉成 512×512 的糊图；
     *  · **产出一定是正方形** —— 边长取"短边"而不是"宽"，所以永远裁得下。
     *
     * 取短边而不是宽：横图（1200×400）短边是 400 → 400×400；竖图（400×1200）同理。
     * 从 `rotate()` 之后的元数据读，所以竖拍照片的方向已经修正过了。
     *
     * 用 `let` + 条件赋值而不是三元里的 IIFE：里面要 `await metadata()`，
     * 而 `await` 不能出现在非 async 的箭头函数里（写错会直接是语法错误）。
     */
    let targetSide = maxWidth;
    if (square) {
      const meta = await rotated.metadata();
      const shortSide = Math.min(meta.width ?? maxWidth, meta.height ?? maxWidth);
      targetSide = Math.max(1, Math.min(maxWidth, shortSide));
    }
    const pipeline = square
      ? rotated.resize({
          width: targetSide,
          height: targetSide,
          /**
           * `fit: 'cover'` + `position: 'centre'` = **取中心正方形**：
           * 等比缩放到刚好盖住目标边长，多出来的两边裁掉。
           *
           * ⚠️ **这里不能加 `withoutEnlargement`**（踩过）：它会让"短边放大到目标边长"这一步
           * 被跳过，于是 1200×400 的横图裁出来是 `512×400` 而不是 `512×512` ——
           * 看着宽度对了、其实根本不是正方形（用户要的正是"存进去就是方的"）。
           * 真机/本地实测：1200×400 带 `withoutEnlargement` → 512×400（非方）。
           *
           * 真正的"不放大原图"由上面那道 [targetSide] 闸门保证：目标边长已经
           * coerce 到不超过短边，所以这里的放大永远只发生在"缩到目标"这个方向。
           */
          fit: 'cover',
          position: 'centre',
        })
      : rotated.resize({ width: maxWidth, withoutEnlargement: true });
    let out = pipeline;
    if (ext === '.png') {
      out = out.png({ quality, compressionLevel: 9 });
    } else if (ext === '.webp') {
      out = out.webp({ quality });
    } else {
      out = out.jpeg({ quality, mozjpeg: true });
    }
    await out.toFile(tmpPath);
    await fs.promises.rename(tmpPath, targetPath);
    if (outJpeg && targetPath !== filePath) {
      await fs.promises.unlink(filePath); // 删除原 avif
    }
  } catch (err) {
    logger.error({ err }, `压缩图片失败 ${filePath}`);
  }
  return targetPath;
}

/**
 * 把 HEIC/HEIF 解码成 JPEG 写入同目录（扩展名换 .jpg），删除原文件
 * P3 修复：解码在 worker_threads 中执行（heic-convert WASM 是同步
 * CPU 密集，主线程直接跑会阻塞事件循环），文件 IO 改用 fs.promises 异步。
 */
async function convertHeicToJpeg(heicPath: string): Promise<string> {
  const jpgPath = heicPath.replace(/\.(heic|heif)$/i, '.jpg');
  const jpeg = await convertHeicInWorker(heicPath);
  await fs.promises.writeFile(jpgPath, jpeg);
  await fs.promises.unlink(heicPath);
  return jpgPath;
}
