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

export function useComposerLifecycle({
  hasContent,
  onConfirmDiscard,
  closeCreate,
}: UseComposerLifecycleOptions) {
  const [closing, setClosing] = useState(false);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);

  // P1 修复：打开时推入历史记录（让返回键触发放弃操作），关闭时把这条记录归还。
  // 此前只 push 不还，关闭弹窗后按返回键会先消费这条僵尸记录，产生一次无效返回。
  const pushedRef = useRef(false);
  /** 本次 history.back() 由本组件发起：popstate 处理器据此消费事件，避免二次触发放弃流程 */
  const selfBackRef = useRef(false);

  const consumeHistoryEntry = useCallback(() => {
    if (!pushedRef.current) return;
    pushedRef.current = false;
    selfBackRef.current = true;
    window.history.back();
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
    window.history.pushState(null, '', window.location.href);
    pushedRef.current = true;
    // 卸载兜底：弹窗被外部直接关闭（如安卓返回键经 App 处理器 closeCreate）
    // 时也要归还占用的历史条目，避免历史栈无限增长/留下僵尸返回
    return () => {
      if (pushedRef.current) {
        pushedRef.current = false;
        selfBackRef.current = true;
        window.history.back();
      }
    };
  }, []);

  // Android 返回键：触发放弃操作
  // 使用 capture phase + stopPropagation 阻止其他页面（Messages/Profile）的 popstate 处理器
  useEffect(() => {
    const handlePopState = (e: PopStateEvent) => {
      e.stopPropagation(); // 阻止其他窗口级 popstate 监听器（历史注释指 HomePage，实际为 Messages/Profile）
      if (selfBackRef.current) {
        // 本组件自己发起的 back（归还历史条目）：静默消费，不触发放弃流程
        selfBackRef.current = false;
        return;
      }
      // 用户按浏览器/安卓返回键：历史条目已被浏览器消费，此后关闭无需再归还
      pushedRef.current = false;
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
