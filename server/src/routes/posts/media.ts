/**
 * ============================================================
 * 帖子路由（/api/posts）- 视频上传与临时文件管理
 * ============================================================
 * 分片上传会话注册表已抽至 lib/chunkUploadRegistry.ts（行为不变），
 * 本文件改为 import 使用；属主校验语义逐字节不变
 * （含「无属主放行」的旧文件兜底）。
 */

import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { PATHS } from '../../config';
import { authMiddleware } from '../../middleware/auth';
import { asyncHandler, AppError } from '../../middleware/error';
import { compressImage, withImages, IMAGE_EXT_RE, IMAGE_MIME_RE } from '../../lib/image';
import { safeDeleteFile } from '../../lib/file';
import { postTextSchema } from '@k/shared/schemas';
import { extractTags } from '@k/shared';
import { enqueueVideoTranscode } from '../../lib/video/queue';
import { generateVideoCover } from '../../lib/video/transcode';
import multer from 'multer';
import { createUploader, timestampFilename } from '../../lib/upload';
import * as postRepo from '../../repositories/post.repo';
import {
  pruneChunkUploads,
  getChunkOwner,
  acquireChunkUpload,
  releaseChunkUpload,
  registerChunkUpload,
  TEMP_VIDEO_NAME_RE,
  MAX_TOTAL_CHUNKS,
  MAX_VIDEO_BYTES,
} from '../../lib/chunkUploadRegistry';

const router = Router();

/** 图片压缩参数（封面最大1920px，质量80） */
const POST_IMAGE_MAX = 1920;

/** 允许的视频扩展名 */
const VIDEO_EXTS = ['.mp4', '.mov', '.avi', '.webm', '.mkv', '.flv', '.wmv'];

/**
 * 视频上传中间件: 限制300MB
 * fileFilter 在白名单内才落盘，拒绝的文件不写入磁盘
 * 按字段区分: video 字段仅接受视频，cover 字段接受图片封面
 *
 * 安全规则: 扩展名与 mimetype 必须"同时"满足白名单（任一可被客户端伪造；
 * 落盘保留用户扩展名，扩展名白名单保证静态服务不会以 html/svg 等危险类型响应）
 */
const videoUpload = createUploader({
  dir: PATHS.uploads,
  filename: timestampFilename('post'),
  maxSize: 300 * 1024 * 1024,
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (file.fieldname === 'cover') {
      if (IMAGE_EXT_RE.test(ext) && IMAGE_MIME_RE.test(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error('仅支持 jpg/png/gif/webp 格式的封面图片'));
      }
      return;
    }
    if (
      VIDEO_EXTS.includes(ext) &&
      (file.mimetype.startsWith('video/') || file.mimetype === 'application/octet-stream')
    ) {
      cb(null, true);
    } else {
      cb(new Error('仅支持视频格式文件'));
    }
  },
});

/**
 * 临时视频存储: 选择视频后立即上传到 uploads/temp/ 用于预览（HTTP Range 播放），
 * 发布时再移动到 uploads/ 正式目录。部分浏览器/WebView 加载 blob: 视频会卡死，
 * HTTP URL 与信息流视频走同一套可靠的 RANGE 请求通道。
 */
const videoTempUpload = createUploader({
  dir: PATHS.uploadsTemp,
  filename: timestampFilename('temp'),
  maxSize: 300 * 1024 * 1024,
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (
      VIDEO_EXTS.includes(ext) &&
      (file.mimetype.startsWith('video/') || file.mimetype === 'application/octet-stream')
    ) {
      cb(null, true);
    } else {
      cb(new Error('仅支持视频格式文件'));
    }
  },
});

/**
 * 视频统一改存 .mp4 扩展名（纯重命名，内容不变）。
 * 后台转码会原地替换内容，URL 从入库起永不变化，
 * 前端无需感知"转码后文件名从 .mov 变 .mp4"这件事。
 */
function normalizeVideoToMp4(dir: string, name: string): string {
  const ext = path.extname(name);
  if (ext.toLowerCase() === '.mp4') return name;
  const to = `${name.slice(0, -ext.length)}.mp4`;
  fs.renameSync(path.join(dir, name), path.join(dir, to));
  return to;
}

/** 启动时清理超过 24 小时未发布的临时视频文件（目录不存在则创建——全新环境/CI 无 uploads/temp） */
(() => {
  try {
    const tempDir = PATHS.uploadsTemp;
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
      return;
    }
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const name of fs.readdirSync(tempDir)) {
      const p = path.join(tempDir, name);
      try {
        const st = fs.statSync(p);
        if (st.isFile() && st.mtimeMs < cutoff) fs.unlinkSync(p);
      } catch {
        /* 忽略单个文件错误 */
      }
    }
  } catch {
    /* 忽略 */
  }
})();

// 分片上传：原生 App 大文件（>50M）走此接口，避免单次 300M FormData 一次性进内存导致 WebView OOM 闪退
// 前端切片 5MB/片，顺序 POST 到此接口，服务端 append 到 temp 文件；完成后前端再走现有 POST /video 的 video_url 流程
const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 }, // 单片 5MB + 余量
});

// 分片上传会话注册表（属主绑定 / 并发上限 / 抢占保护 / TTL 清理）已移入
// lib/chunkUploadRegistry.ts，各路由经 pruneChunkUploads / getChunkOwner /
// acquireChunkUpload / releaseChunkUpload / registerChunkUpload 使用。

router.post(
  '/video-chunk',
  authMiddleware,
  chunkUpload.single('chunk'),
  asyncHandler(async (req: Request, res: Response) => {
    pruneChunkUploads();
    const uploadId = typeof req.body.uploadId === 'string' ? req.body.uploadId.trim() : '';
    const chunkIndex = parseInt(req.body.chunkIndex as string, 10);
    const totalChunks = parseInt(req.body.totalChunks as string, 10);
    const chunkFile = req.file;
    if (!TEMP_VIDEO_NAME_RE.test(uploadId)) {
      throw new AppError(400, '无效的上传ID');
    }
    if (
      !Number.isInteger(chunkIndex) ||
      !Number.isInteger(totalChunks) ||
      chunkIndex < 0 ||
      chunkIndex >= totalChunks
    ) {
      throw new AppError(400, '无效的分片参数');
    }
    if (totalChunks > MAX_TOTAL_CHUNKS) {
      throw new AppError(400, '视频超过大小限制');
    }
    if (!chunkFile || !chunkFile.buffer || chunkFile.buffer.length === 0) {
      throw new AppError(400, '分片数据缺失');
    }
    const userId = req.user!.id;
    if (chunkIndex === 0) {
      // 首片 = 新建/重传：他人占用中的会话不可抢占（acquireChunkUpload 内抛 403），
      // 并发数达上限返回 false → 400
      if (!acquireChunkUpload(uploadId, userId)) {
        throw new AppError(400, '同时进行的上传任务过多，请稍后再试');
      }
    } else {
      // 续片：必须存在会话且属主本人
      const owner = getChunkOwner(uploadId);
      if (!owner) {
        throw new AppError(400, '上传会话已失效，请重新上传');
      }
      if (owner.userId !== userId) {
        throw new AppError(403, '无权继续该上传');
      }
    }
    const tempPath = path.join(PATHS.uploadsTemp, uploadId);
    // 首片清理旧残留（大小检查前执行，否则重传会被旧残留体积误拒）
    try {
      // 目录缺失则创建（memoryStorage 不像 diskStorage 那样自动建目录）
      fs.mkdirSync(PATHS.uploadsTemp, { recursive: true });
      if (chunkIndex === 0 && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      // 累计超出总量上限：拒绝并删除半成品（防改小单片大小绕过 totalChunks 上限）
      const existing = fs.existsSync(tempPath) ? fs.statSync(tempPath).size : 0;
      if (existing + chunkFile.buffer.length > MAX_VIDEO_BYTES) {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        throw new AppError(400, '视频超过大小限制');
      }
      // 续片追加（不存在则创建）
      fs.appendFileSync(tempPath, chunkFile.buffer);
      const stat = fs.statSync(tempPath);
      res.json({ ok: true, received: chunkIndex + 1, totalChunks, size: stat.size });
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(500, '分片写入失败');
    }
  })
);

/**
 * POST /api/posts/video-temp - 上传视频到临时目录（发布前预览）
 *
 * 认证: 必须
 * Content-Type: multipart/form-data
 *
 * 表单字段:
 * - video: 视频文件（300MB限制）
 *
 * 成功响应 (201): { url: '/uploads/temp/xxx.mp4' }
 */
router.post(
  '/video-temp',
  authMiddleware,
  videoTempUpload.single('video'),
  asyncHandler(async (req: Request, res: Response) => {
    const videoFile = req.file;
    if (!videoFile) {
      throw new AppError(400, '请选择视频');
    }

    // 拒绝过小/被截断的视频文件（如云端文件只上传了文件头）
    if (videoFile.size < 1024) {
      safeDeleteFile(`/uploads/temp/${videoFile.filename}`, 'uploads');
      throw new AppError(400, '视频文件无效或不完整，请重新选择后再发布');
    }

    // 统一改存 .mp4 扩展名，后台串行转码为浏览器通用格式（H.264 mp4）。
    // 不阻塞本次响应：转码完成后同 URL 原地替换内容，预览即可播放；
    // 转码前 HEVC 等格式在部分浏览器可能暂时无法播放。
    const name = normalizeVideoToMp4(PATHS.uploadsTemp, videoFile.filename);
    enqueueVideoTranscode(path.join(PATHS.uploadsTemp, name), name);
    // 登记属主：与分片上传同一注册表。否则 DELETE /video-temp 与 POST /video
    // 只校验文件名格式，任何登录用户可删除/冒用他人的临时草稿视频
    registerChunkUpload(name, req.user!.id);

    res.status(201).json({ url: `/uploads/temp/${name}` });
  })
);

/**
 * DELETE /api/posts/video-temp - 删除临时视频（放弃发布时清理）
 *
 * 请求体: { url: '/uploads/temp/xxx.mp4' }
 */
router.delete(
  '/video-temp',
  authMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    const url = typeof req.body?.url === 'string' ? req.body.url : '';
    const name = path.basename(url);
    if (!TEMP_VIDEO_NAME_RE.test(name)) {
      throw new AppError(400, '无效的视频引用');
    }
    // 属主校验：有属主且非本人 → 拒绝。无属主（服务重启丢失登记的旧文件）放行，
    // 由 24h TTL 清理兜底，避免把用户自己放弃发布的清理路径堵死
    const owner = getChunkOwner(name);
    if (owner && owner.userId !== req.user!.id) {
      throw new AppError(403, '无权删除该临时视频');
    }
    safeDeleteFile(`/uploads/temp/${name}`, 'uploads');
    // 放弃上传：同步释放分片上传会话（文件删除后惰性回收也会兜底）
    releaseChunkUpload(name);
    res.json({ ok: true });
  })
);

/**
 * POST /api/posts/video - 创建视频帖子
 *
 * 认证: 必须
 * Content-Type: multipart/form-data
 *
 * 表单字段:
 * - video: 视频文件（300MB限制，未使用临时上传时）
 * - video_url: 临时视频路径（选择视频时已上传，发布时移动为正式文件）
 * - cover: 视频封面图片（可选）
 * - description: 描述（可选）
 * - close_comments: 是否关闭评论
 *
 * 成功响应 (201): 创建的帖子对象
 */
const videoFields = videoUpload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'cover', maxCount: 1 },
]);
router.post(
  '/video',
  authMiddleware,
  videoFields,
  asyncHandler(async (req: Request, res: Response) => {
    const files = req.files as { [fieldname: string]: Express.Multer.File[] };
    const uploadedVideo = files?.video?.[0];
    const coverFile = files?.cover?.[0];
    const videoUrlField = typeof req.body.video_url === 'string' ? req.body.video_url.trim() : '';

    // 正文长度校验：放在文件移动/转码等副作用之前，失败清理已落盘文件再返回 400
    const parsedText = postTextSchema.pick({ description: true }).safeParse({
      description: typeof req.body.description === 'string' ? req.body.description : '',
    });
    if (!parsedText.success) {
      if (uploadedVideo) safeDeleteFile(`/uploads/${uploadedVideo.filename}`, 'uploads');
      if (coverFile) safeDeleteFile(`/uploads/${coverFile.filename}`, 'uploads');
      throw new AppError(400, parsedText.error.issues[0]?.message || '参数错误');
    }

    let videoUrl: string;

    if (videoUrlField) {
      // 使用选择视频时已上传的临时文件，移动到正式目录
      const name = path.basename(videoUrlField);
      if (!TEMP_VIDEO_NAME_RE.test(name)) {
        throw new AppError(400, '无效的视频引用');
      }
      // 属主校验：有属主且非本人 → 拒绝（防冒用他人草稿；无属主为重启前的旧文件，放行）
      const owner = getChunkOwner(name);
      if (owner && owner.userId !== req.user!.id) {
        throw new AppError(403, '无权使用该临时视频');
      }
      const tempPath = path.join(PATHS.uploadsTemp, name);
      const finalPath = path.join(PATHS.uploads, name);
      if (!fs.existsSync(tempPath)) {
        throw new AppError(400, '视频已失效，请重新选择视频');
      }
      fs.renameSync(tempPath, finalPath);
      // 分片上传会话随文件消费而结束
      releaseChunkUpload(name);
      // 兼容旧客户端残留的非 .mp4 临时文件名：统一规范化并入队转码
      const normalizedName = normalizeVideoToMp4(PATHS.uploads, name);
      enqueueVideoTranscode(path.join(PATHS.uploads, normalizedName), normalizedName);
      videoUrl = `/uploads/${normalizedName}`;
    } else {
      if (!uploadedVideo) {
        throw new AppError(400, '请选择视频');
      }

      // 二次验证视频文件类型（防御性检查，fileFilter 已拦截大部分非法文件）
      const videoExt = path.extname(uploadedVideo.originalname).toLowerCase();
      if (!uploadedVideo.mimetype.startsWith('video/') && !VIDEO_EXTS.includes(videoExt)) {
        // 删除已上传的文件
        safeDeleteFile(`/uploads/${uploadedVideo.filename}`, 'uploads');
        throw new AppError(400, '仅支持视频格式文件');
      }

      // 拒绝过小/被截断的视频文件（如云端文件只上传了文件头）
      if (uploadedVideo.size < 1024) {
        safeDeleteFile(`/uploads/${uploadedVideo.filename}`, 'uploads');
        if (coverFile) safeDeleteFile(`/uploads/${coverFile.filename}`, 'uploads');
        throw new AppError(400, '视频文件无效或不完整，请重新选择后再发布');
      }

      // 统一改存 .mp4 扩展名，后台串行转码（发布立即成功，转码完成后原地替换）
      const normalizedName = normalizeVideoToMp4(PATHS.uploads, uploadedVideo.filename);
      enqueueVideoTranscode(path.join(PATHS.uploads, normalizedName), normalizedName);
      videoUrl = `/uploads/${normalizedName}`;
    }

    // 封面：优先用客户端截取的封面图；缺失时服务端自动从视频截帧兜底
    // （客户端 canvas 截帧可能失败：浏览器解不了 HEVC、同值 seek 不触发 seeked 等）
    let videoCover: string | null = null;
    if (coverFile) {
      const coverPath = await compressImage(path.join(PATHS.uploads, coverFile.filename), {
        maxWidth: POST_IMAGE_MAX,
      });
      videoCover = `/uploads/${path.basename(coverPath)}`;
    } else {
      const videoAbs = path.join(PATHS.uploads, path.basename(videoUrl));
      const coverAbs = videoAbs.replace(/\.[^.]+$/, '.jpg');
      const generated = await generateVideoCover(videoAbs, coverAbs);
      if (generated) videoCover = `/uploads/${path.basename(generated)}`;
    }

    const description = parsedText.data.description;
    const closeComments = req.body.close_comments === '1' ? 1 : 0;
    const pinned = req.body.pinned === '1' ? 1 : 0;

    const post = postRepo.createVideoPost({
      userId: req.user!.id,
      videoUrl,
      videoCover,
      description,
      closeComments,
      pinned,
    });
    postRepo.syncPostTags(post.id, extractTags(description));

    res.status(201).json(withImages(post));
  })
);

export default router;
