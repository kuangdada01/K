/**
 * ============================================================
 * 帖子路由（/api/posts）- 组合入口
 * ============================================================
 * 按功能域拆分为 crud / media / interactions / comments 四个子路由，
 * 挂载顺序与原单文件注册顺序语义等价。
 */

import { Router } from 'express';
import crudRouter from './crud';
import mediaRouter from './media';
import interactionRouter from './interactions';
import commentRouter from './comments';

const router = Router();

router.use(crudRouter);
router.use(mediaRouter);
router.use(interactionRouter);
router.use(commentRouter);

export default router;
