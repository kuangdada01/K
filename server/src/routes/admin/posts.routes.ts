/**
 * ============================================================
 * 管理后台 - 帖子管理路由（/api/admin/posts，自 routes/admin.ts 拆出）
 * ============================================================
 *
 * API 端点:
 * - GET    /api/admin/posts     - 获取所有帖子（分页）
 * - DELETE /api/admin/posts/:id - 删除帖子
 *
 * 认证 + 管理员权限由组合入口 routes/admin/index.ts 的全局中间件保障。
 */

import { Router, Request, Response } from 'express';
import { asyncHandler, AppError } from '../../middleware/error';
import { withImages } from '../../lib/image';
import { deletePostMediaFiles } from '../../lib/file';
import { pageQuerySchema, limitQuerySchema } from '@k/shared/schemas';
import * as adminRepo from '../../repositories/admin.repo';

const router = Router();

/**
 * GET /api/admin/posts - 获取所有帖子（分页）
 *
 * 查询参数:
 * - page: 页码（默认1）
 * - limit: 每页数量（默认20）
 */
router.get(
  '/posts',
  asyncHandler(async (req: Request, res: Response) => {
    const page = pageQuerySchema.parse(req.query.page);
    const limit = limitQuerySchema.parse(req.query.limit);

    const { posts, total } = adminRepo.listAllPosts(page, limit);

    // 解析图片JSON
    const postsWithImages = posts.map((p) => withImages(p));

    res.json({ posts: postsWithImages, total, page, totalPages: Math.ceil(total / limit) });
  })
);

/**
 * DELETE /api/admin/posts/:id - 删除帖子
 *
 * 先删除相关通知，再删除帖子；媒体文件（图片/视频/封面）同步清理
 */
router.delete(
  '/posts/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const postId = parseInt(req.params.id as string);
    const media = adminRepo.findPostMedia(postId);
    if (!media) {
      throw new AppError(404, '帖子不存在');
    }
    adminRepo.adminDeletePost(postId);
    deletePostMediaFiles(media);
    res.json({ success: true });
  })
);

export default router;
