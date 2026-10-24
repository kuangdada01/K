/**
 * ============================================================
 * 管理后台路由组合入口（/api/admin，自 routes/admin.ts 拆分为多域子路由）
 * ============================================================
 * 全局中间件只挂一次：authMiddleware → adminMiddleware，再挂四个子路由
 * （users / posts / announcements / reports），全部子路由端点继承认证 + 管理员权限。
 *
 * app.ts 中 `import adminRoutes from './routes/admin'` 无需改动——
 * TypeScript/Node 会把目录导入解析到本文件（index.ts）。
 */

import { Router } from 'express';
import { authMiddleware, adminMiddleware } from '../../middleware/auth';
import usersRouter from './users.routes';
import postsRouter from './posts.routes';
import announcementsRouter from './announcements.routes';
import reportsRouter from './reports.routes';

const router = Router();

/**
 * 全局中间件: 所有管理员路由需要认证 + 管理员权限
 * （只挂一次，全部子路由继承，与拆分前行为一致）
 */
router.use(authMiddleware, adminMiddleware);

router.use(usersRouter);
router.use(postsRouter);
router.use(announcementsRouter);
router.use(reportsRouter);

export default router;
