/**
 * ============================================================
 * 帖子路由（/api/posts）- 视频上传与临时文件管理
 * ============================================================
 * 分片上传会话注册表（lib/chunkUploadRegistry，SQLite 持久化）与转码队列
 * （lib/video/queue，media_jobs 持久化）经 import 使用。
 * 属主校验语义（P1-3.4）：会话已持久化 —— 无登记的临时文件按未知属主
 * 隔离拒绝（TTL 回收），不再有「无属主放行」路径。
 */

import { Router, Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import { PATHS } from '../../config';
import { authMiddleware } from '../../middleware/auth';
import { asyncHandler, AppError } from '../../middleware/error';
import { compressImage, withImages, IMAGE_EXT_RE, IMAGE_MIME_RE } from '../../lib/image';
import { safeDeleteFile, safeDeleteUpload } from '../../lib/file';
import { postTextSchema } from '@k/shared/schemas';
import { extractTags } from '@k/shared';
import { enqueueVideoTranscode, latestTranscodeJob } from '../../lib/video/queue';
import { generateVideoCover, isPlayableVideoStream } from '../../lib/video/transcode';
import { probeVideoStream } from '../../lib/video/probe';
import multer from 'multer';
import { createUploader, timestampFilename } from '../../lib/upload';
import * as postRepo from '../../repositories/post.repo';
import {
  pruneChunkUploads,
  getChunkOwner,
  acquireChunkUpload,
  releaseChunkUpload,
  registerChunkUpload,
  recordChunkAck,
  markChunkUploadConsumed,
  withChunkWriteLock,
  sha256Buffer,
  sha256File,
  getTempQuotaRemaining,
  hasTempUploadSlot,
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
 * 视频上传中间件: 限制1GB（MAX_VIDEO_BYTES）
 * fileFilter 在白名单内才落盘，拒绝的文件不写入磁盘
 * 按字段区分: video 字段仅接受视频，cover 字段接受图片封面
 *
 * 安全规则: 扩展名与 mimetype 必须"同时"满足白名单（任一可被客户端伪造；
 * 落盘保留用户扩展名，扩展名白名单保证静态服务不会以 html/svg 等危险类型响应）
 */
const videoUpload = createUploader({
  dir: PATHS.uploads,
  filename: timestampFilename('post'),
  maxSize: MAX_VIDEO_BYTES,
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
  maxSize: MAX_VIDEO_BYTES,
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

/** 临时视频存活上限：未发布的草稿视频在 uploads/temp 最多保留 24 小时 */
const TEMP_VIDEO_TTL_MS = 24 * 3600 * 1000;
/** 临时目录清理周期 */
const TEMP_SWEEP_INTERVAL_MS = 3600 * 1000;
/** multipart 边界/头部开销的宽裕量（用于 Content-Length 预判用户配额） */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/**
 * 清理 uploads/temp 下超过 TTL 的临时视频，并同步回收过期会话登记
 * （登记不回收会让每用户配额统计残留虚高字节数）。
 * 返回删除的文件数。
 */
export function sweepTempVideos(now: number = Date.now()): number {
  const tempDir = PATHS.uploadsTemp;
  let removed = 0;
  try {
    if (!fs.existsSync(tempDir)) {
      // 全新环境/CI 无 uploads/temp：建目录后无事可做
      fs.mkdirSync(tempDir, { recursive: true });
      return 0;
    }
    const cutoff = now - TEMP_VIDEO_TTL_MS;
    for (const name of fs.readdirSync(tempDir)) {
      const p = path.join(tempDir, name);
      try {
        const st = fs.statSync(p);
        if (st.isFile() && st.mtimeMs < cutoff) {
          fs.unlinkSync(p);
          removed++;
        }
      } catch {
        /* 忽略单个文件错误 */
      }
    }
  } catch {
    /* 忽略目录级错误 */
  }
  pruneChunkUploads();
  return removed;
}

/**
 * 启动时立即清理一次，此后每小时一次。原实现只在模块加载时扫一次——进程不重启就永不回收，
 * 未发布的 1GB 草稿会一直占着磁盘。定时器 unref：不阻止进程退出。
 *
 * 由 index.ts（仅 bootstrap）显式调用，**不能**放在模块顶层：sweep 会经
 * pruneChunkUploads 惰性初始化**默认**数据库，模块加载期触发既打破
 * 「测试与真实 k.db 零接触」的不变量，CI 多 worker 并发首启还会撞
 * SqliteError: database is locked。
 */
export function startTempVideoSweeper(): void {
  sweepTempVideos();
  setInterval(() => sweepTempVideos(), TEMP_SWEEP_INTERVAL_MS).unref();
}

// 分片上传：原生 App 大文件（>50M）走此接口，避免单次 1G FormData 一次性进内存导致 WebView OOM 闪退
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
    // 客户端分片摘要（可选，hex64）：服务端总是自行计算并以此为准做幂等比对，
    // 客户端字段不匹配时按内容损坏拒绝 —— 防传输截断被当作「同片不同内容」
    const clientSha =
      typeof req.body.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(req.body.sha256)
        ? req.body.sha256.toLowerCase()
        : null;
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
    const buffer = chunkFile.buffer;
    const serverSha = sha256Buffer(buffer);
    if (clientSha && clientSha !== serverSha) {
      throw new AppError(400, '分片校验失败，请重试');
    }
    if (chunkIndex === 0) {
      // 首片：新会话走获取（他人占用抛 403 / 并发上限返回 false → 400）；
      // 已有本人会话时**不重新获取** —— 重置进度会让「响应丢失后的首片重放」
      // 把已确认的分片记录清空、截断已写内容。重放与否交给写锁内的摘要判定。
      const existing = getChunkOwner(uploadId);
      if (!existing) {
        if (!acquireChunkUpload(uploadId, userId, totalChunks)) {
          throw new AppError(400, '同时进行的上传任务过多，请稍后再试');
        }
      } else if (existing.userId !== userId) {
        throw new AppError(403, '该上传已被其他用户占用');
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
    // 目录缺失则创建（memoryStorage 不像 diskStorage 那样自动建目录）
    await fs.promises.mkdir(PATHS.uploadsTemp, { recursive: true });

    // 顺序判定与写入都在同会话写锁内：并发的重试/乱序请求逐个串行化，
    // 偏移取会话内记账的 receivedBytes（固定偏移），不读文件现有大小 ——
    // 「服务端已写入但响应丢失」后的重放走 chunks 摘要比对，不会二次追加。
    const acked = await withChunkWriteLock(uploadId, async () => {
      const entry = getChunkOwner(uploadId);
      if (!entry) {
        throw new AppError(400, '上传会话已失效，请重新上传');
      }
      // 同一 uploadId 的总片数必须前后一致：不一致说明客户端状态已错乱，
      // 按冲突拒绝而不是默默按新总数续写（偏移/摘要都会对不上）
      if (entry.totalChunks !== totalChunks) {
        throw new AppError(400, '分片总数与已记录的上传不一致，请重新上传');
      }
      // 1) 重放：该分片已确认过。内容一致 → 返回原确认（幂等，不重复写盘、不重复记账）；
      //    内容不一致 → 409 拒绝（同片不同内容说明客户端切片或传输已损坏）
      const prevAck = entry.chunks.get(chunkIndex);
      if (prevAck) {
        if (prevAck.sha256 === serverSha && prevAck.size === buffer.length) {
          return { received: entry.nextChunk, size: entry.receivedBytes, replay: true };
        }
        throw new AppError(409, `分片 ${chunkIndex} 与已接收内容不一致，请重新上传`, {
          expectedChunkIndex: entry.nextChunk,
        });
      }
      // 2) 乱序/跳片：拒绝并带期望片号，客户端据此恢复续传
      if (chunkIndex !== entry.nextChunk) {
        throw new AppError(409, `分片顺序错误：期望第 ${entry.nextChunk} 片`, {
          expectedChunkIndex: entry.nextChunk,
        });
      }
      // 3) 首片以 'w' 截断可能的历史残留；续片固定偏移写入。
      //    'r+' 在文件不存在时抛 ENOENT —— 这正是「会话已被 POST /video 消费、
      //    临时文件已改名到正式目录」的判定依据。
      let handle: fs.promises.FileHandle;
      try {
        handle = await fs.promises.open(tempPath, chunkIndex === 0 ? 'w' : 'r+');
      } catch (err) {
        if ((err as { code?: string }).code === 'ENOENT') {
          throw new AppError(400, '上传会话已失效，请重新上传');
        }
        throw new AppError(500, '分片写入失败');
      }
      try {
        // 累计超出总量上限：拒绝（防改小单片大小绕过 totalChunks 上限）
        if (entry.receivedBytes + buffer.length > MAX_VIDEO_BYTES) {
          // 半成品与会话一并作废，避免下一次重传被旧残留体积误拒
          await handle.close();
          await fs.promises.unlink(tempPath).catch(() => {});
          releaseChunkUpload(uploadId);
          throw new AppError(400, '视频超过大小限制');
        }
        await handle.write(buffer, 0, buffer.length, entry.receivedBytes);
        await handle.close();
      } catch (err) {
        if (err instanceof AppError) throw err;
        await handle.close().catch(() => {});
        throw new AppError(500, '分片写入失败');
      }
      // 写入成功才记确认：推进 nextChunk/receivedBytes（偏移与配额的同一事实来源）
      recordChunkAck(uploadId, chunkIndex, { size: buffer.length, sha256: serverSha });
      const updated = getChunkOwner(uploadId)!;
      return { received: updated.nextChunk, size: updated.receivedBytes, replay: false };
    });

    // 写入期间会话可能已被 POST /video 消费（临时文件已改名到正式目录）：
    // 我们刚重建的这个残片必须删掉，否则留下无属主孤儿
    if (!getChunkOwner(uploadId)) {
      await fs.promises.unlink(tempPath).catch(() => {});
      throw new AppError(400, '上传会话已失效，请重新上传');
    }
    res.json({ ok: true, received: acked.received, totalChunks, size: acked.size, replay: acked.replay });
  })
);

/**
 * POST /api/posts/video-temp - 上传视频到临时目录（发布前预览）
 *
 * 认证: 必须
 * Content-Type: multipart/form-data
 *
 * 表单字段:
 * - video: 视频文件（1GB限制）
 *
 * 成功响应 (201): { url: '/uploads/temp/xxx.mp4' }
 */
/**
 * 临时视频上传前置闸门：在 multer 落盘之前就按 Content-Length 拒绝，
 * 避免「先写完 1GB 再删」的白白写盘。
 * - 并发槽位：同一用户同时进行的临时上传数（登记表里的会话数）有上限
 * - 字节配额：Content-Length 减去 multipart 头部开销后与剩余配额比较
 * Content-Length 缺失（分块传输）时预判失效，由落盘后的复核兜底。
 */
function tempUploadGuard(req: Request, _res: Response, next: NextFunction): void {
  const userId = req.user!.id;
  pruneChunkUploads();
  if (!hasTempUploadSlot(userId)) {
    throw new AppError(429, '同时进行的临时视频上传过多，请稍后再试');
  }
  const declared = Number(req.headers['content-length'] ?? 0);
  if (
    Number.isFinite(declared) &&
    declared > MULTIPART_OVERHEAD_BYTES &&
    declared - MULTIPART_OVERHEAD_BYTES > getTempQuotaRemaining(userId)
  ) {
    throw new AppError(413, '临时视频空间不足，请先发布或放弃已有草稿视频');
  }
  next();
}

router.post(
  '/video-temp',
  authMiddleware,
  tempUploadGuard,
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

    // 落盘后的配额复核：预判依赖 Content-Length，分块传输时拿不到，这里兜底
    if (videoFile.size > getTempQuotaRemaining(req.user!.id)) {
      safeDeleteFile(`/uploads/temp/${videoFile.filename}`, 'uploads');
      throw new AppError(413, '临时视频空间不足，请先发布或放弃已有草稿视频');
    }

    // 统一改存 .mp4 扩展名，后台串行转码为浏览器通用格式（H.264 mp4）。
    // 不阻塞本次响应：转码完成后同 URL 原地替换内容，预览即可播放；
    // 转码前 HEVC 等格式在部分浏览器可能暂时无法播放。
    const name = normalizeVideoToMp4(PATHS.uploadsTemp, videoFile.filename);
    // 登记属主（并计入该用户的临时目录配额）：与分片上传同一注册表。否则
    // DELETE /video-temp 与 POST /video 只校验文件名格式，任何登录用户可删除/冒用他人的临时草稿视频
    registerChunkUpload(name, req.user!.id, videoFile.size);
    try {
      enqueueVideoTranscode(path.join(PATHS.uploadsTemp, name), name);
    } catch (err) {
      // 队列已满（429）：刚登记并落盘的临时文件必须当场回收，
      // 否则只能等每小时一次的 TTL 清理，白占磁盘与用户配额
      safeDeleteFile(`/uploads/temp/${name}`, 'uploads');
      releaseChunkUpload(name);
      throw err;
    }

    res.status(201).json({ url: `/uploads/temp/${name}` });
  })
);

/**
 * GET /api/posts/video-temp/status - 查询临时视频转码状态（发布前预览轮询）
 *
 * 认证: 必须；属主校验与 DELETE /video-temp 一致。
 * 查询参数: url=/uploads/temp/xxx.mp4
 *
 * 转码完成判据 = 文件内容已是可播规格（H.264 且 level/分辨率在硬件解码
 * 能力内；ensurePlayableVideo 成功后原地替换，队列不跟踪单文件状态，直接
 * 探测流规格最可靠）。4K H.264（level 5.x）同样判为未完成——多数移动端
 * 浏览器/WebView 硬件解码器解不了，需降级转码到 1080p：
 * - done:    已是可播 H.264 → 客户端可加载预览
 * - encoding: 排队中/转码中（或转码失败保留原文件，客户端轮询超时兜底）
 * - missing:  文件不存在（上传未完成或已被 TTL 清理）
 * ffprobe 探测失败（异常文件/ffprobe 缺失）保守视为 encoding，不误报 done。
 */
router.get(
  '/video-temp/status',
  authMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    const url = typeof req.query.url === 'string' ? req.query.url.trim() : '';
    const name = path.basename(url);
    if (!TEMP_VIDEO_NAME_RE.test(name)) {
      throw new AppError(400, '无效的视频引用');
    }
    // 属主校验（与 DELETE /video-temp 一致）：暴露文件是否转码完成属隐私信息
    const owner = getChunkOwner(name);
    if (owner && owner.userId !== req.user!.id) {
      throw new AppError(403, '无权查看该临时视频');
    }
    const filePath = path.join(PATHS.uploadsTemp, name);
    if (!fs.existsSync(filePath)) {
      res.json({ status: 'missing' });
      return;
    }
    const info = await probeVideoStream(filePath);
    // 动态状态接口必须禁缓存：Express 默认 ETag 会让浏览器把首次响应缓存起来，
    // 后续轮询命中 304（body 为空，axios data=undefined），客户端永远读不到
    // "done"——转码完成后自动显示失效，只能手动点重试
    res.setHeader('Cache-Control', 'no-store');
    if (isPlayableVideoStream(info)) {
      res.json({ status: 'done' });
      return;
    }
    // 转码任务已最终失败（重试耗尽）→ 如实暴露 failed（P1-3.4），
    // 不再无限归入 encoding 让客户端轮询到超时
    const job = latestTranscodeJob(filePath);
    if (job?.status === 'failed') {
      res.json({ status: 'failed', error: job.lastError ?? '视频处理失败' });
      return;
    }
    res.json({ status: 'encoding' });
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
    // 属主校验（P1-3.4）：有属主且非本人 → 拒绝；**无属主（无登记的旧文件）同样拒绝**——
    // 会话已持久化，无登记说明是部署前遗留/来历不明的文件，按未知属主隔离，
    // 由 24h TTL 清理兜底，不能被新请求接管（旧版“无属主放行”会让任何登录用户可删他人文件）
    const owner = getChunkOwner(name);
    if (!owner) {
      throw new AppError(403, '临时视频不存在或已失效');
    }
    if (owner.userId !== req.user!.id) {
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
 * - video: 视频文件（1GB限制，未使用临时上传时）
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

    /**
     * 本次请求已移入正式目录（server/uploads）的媒体文件绝对路径。
     * 视频/封面都是「先落盘、后写库」，两者之间任何一步失败（转码队列满 429、
     * 封面截帧、DB 写入）都会留下无 DB 引用的孤儿文件 —— 而 24h 清理只覆盖
     * uploads/temp。统一登记 + 失败回删。
     */
    const staged: string[] = [];

    try {
      if (videoUrlField) {
        // 使用选择视频时已上传的临时文件，移动到正式目录
        const name = path.basename(videoUrlField);
        if (!TEMP_VIDEO_NAME_RE.test(name)) {
          throw new AppError(400, '无效的视频引用');
        }
        // 属主校验（P1-3.4）：无登记（部署前遗留/来历不明）按未知属主隔离拒绝，
        // 不能被新请求接管；有属主且非本人 → 拒绝（防冒用他人草稿）
        const owner = getChunkOwner(name);
        if (!owner) {
          throw new AppError(403, '视频已失效，请重新选择视频');
        }
        if (owner.userId !== req.user!.id) {
          throw new AppError(403, '无权使用该临时视频');
        }
        const tempPath = path.join(PATHS.uploadsTemp, name);
        const finalPath = path.join(PATHS.uploads, name);
        if (!fs.existsSync(tempPath)) {
          throw new AppError(400, '视频已失效，请重新选择视频');
        }
        // 分片会话发布前完整性校验（P0）：片数收齐 + 实际字节数与会话记账一致
        // （客户端另行声明的 video_bytes 亦须吻合，兜住客户端侧切片错位）。
        // 客户端还可带 video_sha256（整文件摘要）做端到端校验；不匹配按损坏拒绝，
        // 绝不把残缺/重复字节的内容发布出去。旧客户端不带摘要时仍以片数+大小为准。
        if (owner.totalChunks > 0) {
          if (owner.nextChunk < owner.totalChunks) {
            throw new AppError(400, '视频尚未上传完成', { expectedChunkIndex: owner.nextChunk });
          }
          const declaredBytes = parseInt(req.body.video_bytes as string, 10);
          if (Number.isInteger(declaredBytes) && declaredBytes !== owner.receivedBytes) {
            throw new AppError(400, '视频大小校验失败，请重新上传', { expectedChunkIndex: owner.nextChunk });
          }
          const actualSize = fs.statSync(tempPath).size;
          if (actualSize !== owner.receivedBytes) {
            safeDeleteFile(`/uploads/temp/${name}`, 'uploads');
            releaseChunkUpload(name);
            throw new AppError(400, '视频大小校验失败，请重新上传');
          }
        }
        const clientTotalSha =
          typeof req.body.video_sha256 === 'string' && /^[0-9a-f]{64}$/i.test(req.body.video_sha256)
            ? req.body.video_sha256.toLowerCase()
            : null;
        if (clientTotalSha && (await sha256File(tempPath)) !== clientTotalSha) {
          safeDeleteFile(`/uploads/temp/${name}`, 'uploads');
          releaseChunkUpload(name);
          throw new AppError(400, '视频校验失败，请重新上传');
        }
        fs.renameSync(tempPath, finalPath);
        // 分片上传会话随文件消费而结束：标记已消费（保留属主记录供追溯，退出配额与活跃判定）
        markChunkUploadConsumed(name);
        // 兼容旧客户端残留的非 .mp4 临时文件名：统一规范化并入队转码
        const normalizedName = normalizeVideoToMp4(PATHS.uploads, name);
        const videoAbs = path.join(PATHS.uploads, normalizedName);
        staged.push(videoAbs);
        enqueueVideoTranscode(videoAbs, normalizedName);
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
        const videoAbs = path.join(PATHS.uploads, normalizedName);
        staged.push(videoAbs);
        enqueueVideoTranscode(videoAbs, normalizedName);
        videoUrl = `/uploads/${normalizedName}`;
      }

      // 封面：优先用客户端截取的封面图；缺失时服务端自动从视频截帧兜底
      // （客户端 canvas 截帧可能失败：浏览器解不了 HEVC、同值 seek 不触发 seeked 等）
      let videoCover: string | null = null;
      if (coverFile) {
        const coverPath = await compressImage(path.join(PATHS.uploads, coverFile.filename), {
          maxWidth: POST_IMAGE_MAX,
        });
        staged.push(coverPath);
        videoCover = `/uploads/${path.basename(coverPath)}`;
      } else {
        const videoAbs = path.join(PATHS.uploads, path.basename(videoUrl));
        const coverAbs = videoAbs.replace(/\.[^.]+$/, '.jpg');
        const generated = await generateVideoCover(videoAbs, coverAbs);
        if (generated) {
          staged.push(generated);
          videoCover = `/uploads/${path.basename(generated)}`;
        }
      }

      const description = parsedText.data.description;
      const closeComments = req.body.close_comments === '1' ? 1 : 0;
      const pinned = req.body.pinned === '1' ? 1 : 0;

      // 帖子行与话题在同一事务内写入：失败即整条回滚，下面按「未创建」回删媒体文件
      const post = postRepo.createVideoPostWithTags(
        {
          userId: req.user!.id,
          videoUrl,
          videoCover,
          description,
          closeComments,
          pinned,
        },
        extractTags(description)
      );

      res.status(201).json(withImages(post));
    } catch (err) {
      for (const absPath of staged) safeDeleteUpload(absPath);
      throw err;
    }
  })
);

export default router;
