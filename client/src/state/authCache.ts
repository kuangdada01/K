/**
 * ============================================================
 * 会话失效/登出时的查询缓存清理（state/authCache）
 * ============================================================
 * B5 修复的修订版。原实现对 401/登出一律 `queryClient.removeQueries()`
 * 全量清空，其中信息流（posts feed）也在被清之列：
 *
 *   401 → removeQueries → usePostsFeed data 变 undefined → 首页信息流
 *   瞬间打回空态 → 页面总高度从数千 px 塌缩到一屏 → 浏览器把
 *   window.scrollY 钳制回 0 → 表现为「浏览帖子时自动跳回头部」，
 *   且 feed 随后重新拉取回来，用户已被弹到顶部（帖子"浏览不完"）。
 *
 * 修订原则：把「跨账号不残留」与「浏览体验」解耦——
 * - posts 系查询（信息流/搜索/个人页帖子列表）是**公开内容**，跨账号
 *   残留无敏感信息，保留它们页面高度不塌缩、滚动位置不丢；
 * - 活跃的 posts 查询改为 invalidate：当前页立即以新会话态（未登录）
 *   refetch 覆盖，liked/shared/reposted 等登录态字段随之归零，
 *   与全量清除在数据正确性上等价；
 * - 其余查询（通知/私信/公告/图书进度等登录私有数据）照旧移除；
 * - 点赞/关注/收藏/转发交互缓存仍全清（clearInteractionCaches）。
 */

import { queryClient } from './queryClient';
import { clearInteractionCaches } from './cache';

export function clearCachesOnAuthLoss(): void {
  // 移除除 posts 系之外的全部查询缓存（登录私有数据，跨账号必须清）
  queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'posts' });
  // posts 查询标脏并触发活跃查询重取：以当前会话态覆盖登录态字段
  queryClient.invalidateQueries({ queryKey: ['posts'] });
  clearInteractionCaches();
}
