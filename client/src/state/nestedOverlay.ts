/**
 * ============================================================
 * 嵌套 PostDetail 协调（state/nestedOverlay）
 * ============================================================
 * 从 PostDetail.tsx 的模块级全局变量封装而来：
 * 跟踪当前活跃的嵌套 PostDetail（在 ProfileOverlay 内部打开的帖子详情），
 * 供安卓返回键处理区分"外层/嵌套"两层弹窗。
 *
 * 说明: 这是跨组件实例的协调状态，必须模块级共享；
 * 封装为具名 API 后语义清晰、可测试，不再散落裸全局变量。
 */

let activeNestedElement: HTMLDivElement | null = null;

/** 防重入标志：避免外层和嵌套 PostDetail 同时处理同一个 backbutton 事件 */
let dispatchingBackButton = false;

/** 注册嵌套 PostDetail 根元素 */
export function setActiveNestedOverlay(el: HTMLDivElement | null): void {
  activeNestedElement = el;
}

/** 当前是否有嵌套 PostDetail */
export function getActiveNestedOverlay(): HTMLDivElement | null {
  return activeNestedElement;
}

/** 消费一次性分发标志：若正处于分发中则清除并返回 false（调用方应跳过处理） */
export function consumeBackDispatch(): boolean {
  if (dispatchingBackButton) {
    dispatchingBackButton = false;
    return false;
  }
  return true;
}

/** 标记分发中（向嵌套弹窗委托关闭时调用，重入事件将被消费） */
export function beginBackDispatch(): void {
  dispatchingBackButton = true;
}
