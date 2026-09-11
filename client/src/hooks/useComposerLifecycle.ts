/**
 * ============================================================
 * 发帖弹窗生命周期 Hook（hooks/useComposerLifecycle）
 * ============================================================
 * 自 CreatePost.tsx 拆出（行为逐字节不变）：
 * - 关闭动画（200ms 后 closeCreate）
 * - 放弃确认（hasContent 时弹确认）
 * - 打开时 pushState 历史条目、关闭/卸载时归还（P1 修复）
 * - popstate（安卓/浏览器返回键）与 ESC 键处理
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseComposerLifecycleOptions {
  hasContent: boolean;
  /** 确认放弃时的清理动作（blob 撤销、字段复位——由组件提供） */
  onConfirmDiscard: () => void;
  closeCreate: () => void;
}

/**
 * 历史条目归属状态放在**模块级**而不是实例 ref：
 * 同一时刻只应有一个弹窗占用 URL 历史条目，而 StrictMode 下 React 会对同一实例
 * 「挂载 → 卸载 → 再挂载」，用实例 ref 无法表达「这条目还归我」。
 */
let entryOwned = false;
/** 归还操作已排期（防止同一轮内重复 back） */
let releaseTimer: ReturnType<typeof setTimeout> | null = null;
/** 本次 back 由本 hook 发起：popstate 处理器据此消费事件，避免二次触发放弃流程 */
let selfBack = false;

/**
 * 占用一条历史条目，让返回键先关闭弹窗而不是直接离开页面。
 * 必须**保留既有 history.state**：React Router 把 `{ idx }` 记账写在里面，
 * 覆盖成 null 会让路由的历史记账与浏览器失同步。
 */
function acquireHistoryEntry(): void {
  // StrictMode 的「再挂载」紧跟在清理之后：取消上一次排期的归还，沿用同一条目
  if (releaseTimer !== null) {
    clearTimeout(releaseTimer);
    releaseTimer = null;
  }
  if (entryOwned) return;
  window.history.pushState({ ...(window.history.state ?? {}), composer: true }, '', window.location.href);
  entryOwned = true;
}

/**
 * 归还占用的历史条目。
 *
 * 两个关键点，都是线上/e2e 实测踩出来的：
 * 1. **推迟一拍再 back()**：清理侧若同步 back()，而紧随其后的再挂载（StrictMode）
 *    又同步 pushState，这次 back 的 popstate 会迟到并吞掉刚压入的条目 ——
 *    此后关闭弹窗时再 back() 就**多退一条**，用户被弹回上一页（e2e 里直接退到 about:blank）。
 * 2. **归还前确认条目还在**：若条目已被丢弃（上述交叠，或弹窗期间发生了别的导航），
 *    再 back() 同样是多退一条，宁可什么都不做。
 */
function releaseHistoryEntry(): void {
  if (!entryOwned || releaseTimer !== null) return;
  releaseTimer = setTimeout(() => {
    releaseTimer = null;
    if (!entryOwned) return;
    entryOwned = false;
    if ((window.history.state as { composer?: unknown } | null)?.composer !== true) return;
    selfBack = true;
    window.history.back();
  }, 0);
}

/** 仅测试用：重置模块级归属状态 */
export function __resetComposerHistoryForTests(): void {
  if (releaseTimer !== null) clearTimeout(releaseTimer);
  releaseTimer = null;
  entryOwned = false;
  selfBack = false;
}

export function useComposerLifecycle({
  hasContent,
  onConfirmDiscard,
  closeCreate,
}: UseComposerLifecycleOptions) {
  const [closing, setClosing] = useState(false);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);

  // P1 修复：打开时推入历史记录（让返回键触发放弃操作），关闭时把这条记录归还。
  // 此前只 push 不还，关闭弹窗后按返回键会先消费这条僵尸记录，产生一次无效返回。
  const consumeHistoryEntry = useCallback(() => {
    releaseHistoryEntry();
  }, []);

  // onConfirmDiscard 经 ref 读取：popstate/ESC effect 的重新注册时机与原实现
  // [showDiscardConfirm, hasContent, handleDiscard] 依赖保持一致
  const onConfirmDiscardRef = useRef(onConfirmDiscard);
  useEffect(() => {
    onConfirmDiscardRef.current = onConfirmDiscard;
  }, [onConfirmDiscard]);

  const handleClose = useCallback(() => {
    consumeHistoryEntry();
    setClosing(true);
    setTimeout(() => {
      closeCreate();
    }, 200);
  }, [closeCreate, consumeHistoryEntry]);

  const handleDiscard = useCallback(() => {
    if (hasContent) {
      setShowDiscardConfirm(true);
    } else handleClose();
  }, [hasContent, handleClose]);

  const confirmDiscard = useCallback(() => {
    onConfirmDiscardRef.current();
    setShowDiscardConfirm(false);
    handleClose();
  }, [handleClose]);

  // 打开时推入历史记录，让返回键可以触发放弃操作；关闭时经 consumeHistoryEntry 归还
  useEffect(() => {
    acquireHistoryEntry();
    // 卸载兜底：弹窗被外部直接关闭（如安卓返回键经 App 处理器 closeCreate）
    // 时也要归还占用的历史条目，避免历史栈无限增长/留下僵尸返回
    return () => {
      releaseHistoryEntry();
    };
  }, []);

  // Android 返回键：触发放弃操作
  // 使用 capture phase + stopPropagation 阻止其他页面（Messages/Profile）的 popstate 处理器
  useEffect(() => {
    const handlePopState = (e: PopStateEvent) => {
      e.stopPropagation(); // 阻止其他窗口级 popstate 监听器（历史注释指 HomePage，实际为 Messages/Profile）
      if (selfBack) {
        // 本组件自己发起的 back（归还历史条目）：静默消费，不触发放弃流程
        selfBack = false;
        return;
      }
      // 用户按浏览器/安卓返回键：历史条目已被浏览器消费，此后关闭无需再归还
      entryOwned = false;
      if (showDiscardConfirm) {
        setShowDiscardConfirm(false);
      } else {
        handleDiscard();
      }
    };
    window.addEventListener('popstate', handlePopState, true); // capture phase
    return () => window.removeEventListener('popstate', handlePopState, true);
  }, [showDiscardConfirm, hasContent, handleDiscard]);

  // ESC 键关闭（有内容时弹出放弃确认）
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showDiscardConfirm) {
          setShowDiscardConfirm(false);
        } else {
          handleDiscard();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [showDiscardConfirm, hasContent, handleDiscard]);

  return {
    closing,
    showDiscardConfirm,
    setShowDiscardConfirm,
    handleClose,
    handleDiscard,
    confirmDiscard,
  };
}
