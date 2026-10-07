/**
 * ============================================================
 * 帖子详情遮罩开关状态（state/postDetailOverlay）
 * ============================================================
 * 为什么需要这个全局状态：
 * PostDetail 的遮罩背景是 `rgba(0, 0, 0, 0.65)`（**半透明**），而首页信息流
 * 并没有卸载——只是被压在下面。于是卡片上的「3 秒自动轮播」在详情页打开期间
 * 仍然**肉眼可见地继续跑**（用户反馈「进详情页还有自动轮播」），
 * 同时也白白消耗合成器与主线程工作量。
 *
 * 信息流卡片（PostCard）订阅本状态，在详情页打开期间暂停自动轮播；
 * 详情页关闭后自动恢复（首页该有的自动播放照旧）。
 *
 * 用**计数**而不是布尔：PostDetail 可以嵌套（ProfileOverlay 里再开一层帖子详情），
 * 任一层关闭都不该被误判成「全部关闭」。
 * ============================================================
 */

let openCount = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** PostDetail 挂载时调用（打开 +1） */
export function pushPostDetailOverlay(): void {
  openCount += 1;
  emit();
}

/** PostDetail 卸载时调用（关闭 -1，不会低于 0） */
export function popPostDetailOverlay(): void {
  openCount = Math.max(0, openCount - 1);
  emit();
}

/** 当前是否有帖子详情遮罩打开（useSyncExternalStore 的 getSnapshot） */
export function isPostDetailOverlayOpen(): boolean {
  return openCount > 0;
}

/** 订阅开关变化（useSyncExternalStore 的 subscribe） */
export function subscribePostDetailOverlay(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** 测试用：重置计数与订阅者 */
export function resetPostDetailOverlayForTest(): void {
  openCount = 0;
  listeners.clear();
}
