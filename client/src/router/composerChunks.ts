/**
 * ============================================================
 * 按需加载入口（router/composerChunks）
 * ============================================================
 * 这几个组件体量不小、却只在用户主动交互时才用得到，此前是**静态导入**，
 * 于是它们的实现被算进首屏 chunk（实测首屏 JS 527.7 KB）：
 * - `CreatePost`（547 行 + 媒体选择/视频封面两个步骤视图）
 * - `EditPost`（412 行）
 * - `PostDetail`（489 行 + 评论树/表情/确认弹窗）
 *
 * 这里把动态 import 收成一处，供两个调用方共用：
 * 1. `AppRoutes` / `HomePage` 用 `lazy(...)` 做真正的按需加载；
 * 2. 入口（侧边栏「分享」、信息流卡片）在 **hover / focus / touchstart** 时预取，
 *    把「首次打开要多等一次 chunk 拉取」这段延迟抹平 ——
 *    从「悬停/按下」到「点击生效」通常有 100ms 以上，足够把 chunk 取回来。
 *
 * Vite 对同一个说明符的动态 import 会去重：预取与 lazy 拿的是同一个 chunk。
 * ============================================================
 */

/** 预取/加载发布弹层（CreatePost） */
export const loadCreatePost = () => import('../components/post/CreatePost');

/** 预取/加载编辑弹层（EditPost） */
export const loadEditPost = () => import('../components/post/EditPost');

/**
 * 预取/加载帖子详情浮层（PostDetail：含评论树、表情选择、确认弹窗）。
 * 首页此前静态引入它，于是整个浮层实现（含评论组件）被算进首屏 chunk；
 * 改成按需加载 + 在信息流卡片 hover/touch 时预取。
 */
export const loadPostDetail = () => import('../components/post/PostDetail');
