/**
 * ============================================================
 * Toast 提示组件
 * ============================================================
 * 全局消息提示，2.5秒自动消失
 *
 * 使用方式:
 * - import { showToast } from './Toast';
 * - showToast('操作成功！');
 *
 * 支持多条同时显示，独立计时消失
 * ============================================================
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import '../../styles/toast.css';

interface ToastItem {
  id: number;
  message: string;
}

let toastId = 0;
let addToastFn: ((message: string) => void) | null = null;

export function showToast(message: string) {
  addToastFn?.(message);
}

export default function Toast() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  /** 每条 toast 的自动消失定时器：容器卸载时统一清理，避免卸载后继续 setState */
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  const addToast = useCallback((message: string) => {
    const id = ++toastId;
    setToasts((prev) => [...prev, { id, message }]);
    const timer = setTimeout(() => {
      timersRef.current.delete(timer);
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 2500);
    timersRef.current.add(timer);
  }, []);

  useEffect(() => {
    addToastFn = addToast;
    return () => {
      addToastFn = null;
    };
  }, [addToast]);

  // 卸载：清掉所有尚未触发的消失定时器（Set 实例在组件生命周期内恒定）
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  return (
    <div className="toast-container">
      {toasts.map((t) => (
        <div key={t.id} className="toast-item">
          {t.message}
        </div>
      ))}
    </div>
  );
}
