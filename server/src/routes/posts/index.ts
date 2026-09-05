/**
 * ============================================================
 * 帖子路由（/api/posts）- 组合入口
 * ============================================================
 * 按功能域拆分为 crud / media / interactions / comments 四个子路由。
 * media 必须挂在 crud 之前：crud 的 DELETE /:id 会把 media 的
 * DELETE /video-temp（静态路径）当作帖子 id 吞掉返回 404。
 */

import { Router } from 'express';
import crudRouter from './crud';
import mediaRouter from './media';
import interactionRouter from './interactions';
import commentRouter from './comments';

const router = Router();

router.use(mediaRouter);
router.use(crudRouter);
router.use(interactionRouter);
router.use(commentRouter);

export default router;
