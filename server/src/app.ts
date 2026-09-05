/**
 * ============================================================
 * Express 应用组装模块（app）
 * ============================================================
 * 组装中间件、路由与静态文件服务；与 index.ts 分离后可直接
 * 以 supertest 或注入依赖的方式测试，无需监听端口。
 */

import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { pinoHttp, stdSerializers } from 'pino-http';
import path from 'path';
import { env, PATHS } from './config';
import { corsMiddleware } from './middleware/cors';
import { errorHandler } from './middleware/error';

// ============================================================
// 路由模块导入
// ============================================================
import authRoutes from './routes/auth'; // 认证路由: /api/auth
import postRoutes from './routes/posts'; // 帖子路由: /api/posts
import userRoutes from './routes/users'; // 用户路由: /api/users
import messageRoutes from './routes/messages'; // 私信路由: /api/messages
import friendRoutes from './routes/friends'; // 好友路由: /api/friends
import notificationRoutes from './routes/notifications'; // 通知路由: /api/notifications
import adminRoutes from './routes/admin'; // 管理路由: /api/admin
import announcementRoutes from './routes/announcements'; // 公告路由: /api/announcements
import bookRoutes from './routes/books'; // 图书路由: /api/books
import musicRoutes from './routes/music'; // 音乐列表: /api/music
import voiceRoutes from './routes/voice'; // 语音房间路由: /api/voice
import eventRoutes from './routes/events'; // SSE 事件流: /api/events
import metaRoutes from './routes/meta'; // 系统元信息: /api/health、/api/app/version

export function createApp(): express.Express {
  const app = express();

  // 站点经 nginx 反向代理（请求均来自本机 127.0.0.1），
  // 信任 loopback 代理使 req.ip 正确解析 X-Forwarded-For，
  // 同时避免 express-rate-limit 因 X-Forwarded-For 头报错
  app.set('trust proxy', 'loopback');

  // ============================================================
  // 全局中间件配置
  // ============================================================

  /** CORS（语义与原手写中间件完全一致，见 middleware/cors.ts） */
  app.use(corsMiddleware);

  /** 安全响应头（helmet）
   * HSTS 由 helmet 默认下发（max-age=1年 + includeSubDomains）；
   * TLS 由 nginx 终止（kuangdada.top 已全站 HTTPS，Let's Encrypt 自动续期）。
   */
  app.use(
    helmet({
      // Capacitor 原生 App 的页面运行在 http://localhost，跨源引用 /uploads 的
      // 图片/视频。helmet 默认 Cross-Origin-Resource-Policy: same-origin 会让
      // Chromium 以 ERR_BLOCKED_BY_RESPONSE 拒绝加载这些媒体（网页版同源无感知）。
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: {
        directives: {
          ...helmet.contentSecurityPolicy.getDefaultDirectives(),
          'script-src': [
            "'self'",
            "'sha256-v5bVaFQO+UhGE6aDcmlclP7lRfBTMRh+5BgGwwfhAuo='",
            "'wasm-unsafe-eval'",
          ],
          // wasm-unsafe-eval: 语音降噪 RNNoise 的 AudioWorklet 在运行期内嵌 WASM 模块
          // 需要该指令（Chrome 对 script-src 无 'unsafe-eval'/'wasm-unsafe-eval' 时会
          // 拒绝编译 WASM → worklet 构造失败 → 降噪输出静音）。
          // blob: 用于视频封面/头像等本地文件预览（URL.createObjectURL），
          // 默认 CSP 仅允许 'self'，会拦截 blob 视频导致黑屏/无法解码
          'media-src': ["'self'", 'blob:'],
          'img-src': ["'self'", 'data:', 'blob:'],
        },
      },
    })
  );

  /** 请求日志（结构化 pino，生产 JSON / 开发可读）
   * redact: 认证凭证不落日志（Bearer JWT 与 SSE ?token= 查询参数）
   * req 序列化器剥掉 query: pino 默认序列化的 req.url 是完整 URL，
   * SSE 的 ?token=JWT 会随 url 明文落日志，只保留 path 部分
   */
  app.use(
    pinoHttp({
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.query.token',
          '*.req.headers.authorization',
        ],
        censor: '[REDACTED]',
      },
      serializers: {
        req: (req) => {
          const s = stdSerializers.req(req);
          return { ...s, url: s.url?.split('?')[0] };
        },
      },
      transport:
        env.NODE_ENV === 'production'
          ? undefined
          : {
              target: 'pino-pretty',
              options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
            },
    })
  );

  /** JSON 请求体解析（限制默认100kb） */
  app.use(express.json());

  /** URL 编码请求体解析（支持表单数据） */
  app.use(express.urlencoded({ extended: true }));

  /** API 写操作全局限流：防止单一来源刷接口（发帖/评论/私信/分片上传等）。
   * /api/auth 有更严格的专属限流（见 routes/auth.ts），此处是兜底的洪水防护；
   * 上限按 IP 计（trust proxy 已解析真实来源），120 次/分钟对正常使用足够宽裕
   * （视频分片上传每片一次请求，串行发出不会触发）。
   */
  const apiWriteLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: '操作过于频繁，请稍后再试' },
  });
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    return apiWriteLimiter(req, res, next);
  });

  /** 静态文件服务: /uploads 路径映射到 server/uploads 目录（缓存7天） */
  app.use(
    '/uploads',
    express.static(PATHS.uploads, {
      maxAge: '7d',
      immutable: false,
    })
  );

  // ============================================================
  // API 路由注册
  // ============================================================

  app.use('/api/auth', authRoutes); // 认证: 注册、登录、获取当前用户
  app.use('/api/posts', postRoutes); // 帖子: CRUD、点赞、评论
  app.use('/api/users', userRoutes); // 用户: 资料、头像、私密图片
  app.use('/api/messages', messageRoutes); // 私信: 会话列表、消息收发
  app.use('/api/friends', friendRoutes); // 好友: 关注、搜索、推荐
  app.use('/api/notifications', notificationRoutes); // 通知: 评论/回复通知
  app.use('/api/admin', adminRoutes); // 管理: 用户/帖子/公告管理
  app.use('/api/announcements', announcementRoutes); // 公告: 查看公告、标记已读
  app.use('/api/books', bookRoutes); // 图书: 书籍列表、详情、章节内容
  app.use('/api/music', musicRoutes); // 音乐: 音乐文件列表
  app.use('/api/voice', voiceRoutes); // 语音: 房间 CRUD、ICE 配置（信令走 /api/voice/ws）
  app.use('/api/events', eventRoutes); // SSE: 实时事件流

  // ============================================================
  // 系统元信息路由（健康检查 + App 版本检测）
  // ============================================================
  app.use('/api', metaRoutes);

  // ============================================================
  // 生产环境静态文件服务
  // ============================================================

  /** 前端构建产物目录: client/dist */
  const clientDist = PATHS.clientDist;

  /** 判断是否为 Vite 构建的带哈希文件名（可长缓存，immutable） */
  const HASHED_ASSET_RE = /[a-zA-Z0-9_-]{8,}\.(js|css|woff2?|ttf|png|jpe?g|gif|svg|webp)$/;

  /**
   * 提供前端静态文件（HTML、CSS、JS、图片等）
   * - HTML: 不缓存，确保总是获取最新版本
   * - 带哈希的构建产物: 长缓存（1年，immutable）
   * - 其他（音乐、静态资源）: 缓存1小时
   */
  app.use(
    express.static(clientDist, {
      setHeaders: (res, path) => {
        if (path.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          res.setHeader('Pragma', 'no-cache');
          res.setHeader('Expires', '0');
        } else if (HASHED_ASSET_RE.test(path)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.setHeader('Cache-Control', 'public, max-age=3600');
        }
      },
    })
  );

  /** 未知 API 路径返回 404 JSON（而不是 SPA 的 index.html） */
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: '接口不存在' });
  });

  /**
   * SPA 路由回退（Express 5 通配符语法 /*splat）
   * 所有未匹配 API 的请求都返回 index.html
   * 由前端路由（react-router-dom）处理具体页面
   */
  app.get('/*splat', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });

  // ============================================================
  // 全局错误处理中间件
  // ============================================================

  /**
   * 统一错误处理（实现见 middleware/error.ts）
   * 捕获所有未处理的错误，对外不泄露内部实现细节
   */
  app.use(errorHandler);

  return app;
}
