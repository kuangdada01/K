/**
 * ============================================================
 * 好友/关注路由模块 (/api/friends)
 * ============================================================
 * 处理用户关注关系（单向关注，类似 Twitter/Instagram）
 *
 * API 端点:
 * - GET    /api/friends              - 获取关注列表
 * - GET    /api/friends/search?q=    - 搜索用户
 * - GET    /api/friends/status/:id   - 查询关注状态
 * - GET    /api/friends/recommend    - 随机推荐未关注用户
 * - POST   /api/friends/:id          - 关注用户
 * - DELETE /api/friends/:id          - 取消关注
 * ============================================================
 */

import { Router, Request, Response } from 'express';
import { authMiddleware, optionalAuth } from '../middleware/auth';
import { asyncHandler, AppError } from '../middleware/error';
import * as friendRepo from '../repositories/friend.repo';

const router = Router();

// ============================================================
// 搜索端点
// ============================================================

/**
 * GET /api/friends/search?q=keyword - 搜索用户
 *
 * 认证: 必须
 *
 * 查询参数:
 * - q: 搜索关键词（用户名模糊匹配或精确ID匹配）
 *
 * 返回最多20个匹配用户，包含关注状态
 */
router.get(
  '/search',
  authMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    const keyword = req.query.q as string;
    const userId = req.user!.id;

    if (!keyword || !keyword.trim()) {
      res.json({ users: [] });
      return;
    }

    const users = friendRepo.searchUsers(keyword, userId);
    res.json({ users });
  })
);

// ============================================================
// 关注状态端点
// ============================================================

/**
 * GET /api/friends/status/:id - 查询关注状态
 *
 * 认证: 必须
 *
 * 返回当前用户是否关注了指定用户
 */
router.get(
  '/status/:id',
  authMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    const targetId = parseInt(req.params.id as string);
    const userId = req.user!.id;

    const following = friendRepo.isFollowing(userId, targetId);
    res.json({ is_following: following });
  })
);

// ============================================================
// 关注/取消关注端点
// ============================================================

/**
 * POST /api/friends/:id - 关注用户
 *
 * 认证: 必须
 *
 * 验证:
 * - 不能关注自己
 * - 目标用户必须存在
 * - 使用 INSERT OR IGNORE 防止重复关注
 *
 * 返回关注状态和目标用户的粉丝数
 */
router.post(
  '/:id',
  authMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    const targetId = parseInt(req.params.id as string);
    const userId = req.user!.id;

    if (targetId === userId) {
      throw new AppError(400, '不能关注自己');
    }

    if (!friendRepo.userExists(targetId)) {
      throw new AppError(404, '用户不存在');
    }

    const followersCount = friendRepo.follow(userId, targetId);
    res.json({ is_following: true, followers_count: followersCount });
  })
);

/**
 * DELETE /api/friends/:id - 取消关注
 *
 * 认证: 必须
 *
 * 返回关注状态和目标用户的粉丝数
 */
router.delete(
  '/:id',
  authMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    const targetId = parseInt(req.params.id as string);
    const userId = req.user!.id;

    const followersCount = friendRepo.unfollow(userId, targetId);
    res.json({ is_following: false, followers_count: followersCount });
  })
);

// ============================================================
// 推荐端点
// ============================================================

/**
 * GET /api/friends/followers/:id - 获取粉丝列表
 *
 * 认证: 必须
 *
 * 返回指定用户的粉丝列表（谁关注了该用户）
 */
router.get(
  '/followers/:id',
  authMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    const targetId = parseInt(req.params.id as string);
    const userId = req.user!.id;

    const followers = friendRepo.listFollowers(targetId, userId);
    res.json({ users: followers });
  })
);

/**
 * GET /api/friends/following/:id - 获取关注列表
 *
 * 认证: 必须
 *
 * 返回指定用户关注的人列表（该用户关注了谁）
 */
router.get(
  '/following/:id',
  authMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    const targetId = parseInt(req.params.id as string);
    const userId = req.user!.id;

    const following = friendRepo.listFollowing(targetId, userId);
    res.json({ users: following });
  })
);

/**
 * GET /api/friends/recommend - 随机推荐用户
 *
 * 认证: 可选（游客返回随机用户，登录用户返回未关注的随机用户）
 *
 * 返回5个随机用户
 * 用于首页右侧推荐关注卡片
 */
router.get(
  '/recommend',
  optionalAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.id;
    const users = friendRepo.listRecommended(userId);
    res.json({ users });
  })
);

// ============================================================
// 关注列表端点
// ============================================================

/**
 * GET /api/friends - 获取关注列表
 *
 * 认证: 必须
 *
 * 返回当前用户关注的所有用户，按用户名排序
 */
router.get(
  '/',
  authMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const friends = friendRepo.listMyFollowing(userId);
    res.json({ friends });
  })
);

export default router;
