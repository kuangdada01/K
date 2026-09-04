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

import { useState, useEffect, useCallback } from 'react';
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

  const addToast = useCallback((message: string) => {
    const id = ++toastId;
    setToasts(prev => [...prev, { id, message }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 2500);
  }, []);

  useEffect(() => {
    addToastFn = addToast;
    return () => { addToastFn = null; };
  }, [addToast]);

  return (
    <div className="toast-container">
      {toasts.map(t => (
        <div key={t.id} className="toast-item">{t.message}</div>
      ))}
    </div>
  );
}