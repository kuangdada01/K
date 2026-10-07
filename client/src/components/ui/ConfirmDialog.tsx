/**
 * ============================================================
 * 确认对话框组件 (ConfirmDialog)
 * ============================================================
 * 通用确认弹窗，支持 ESC 键关闭和动画效果
 * ============================================================
 */

import { useEffect, useState, useCallback } from 'react';
import styles from './ConfirmDialog.module.css';

interface ConfirmDialogProps {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({ message, onConfirm, onCancel }: ConfirmDialogProps) {
  const [closing, setClosing] = useState(false);

  const handleClose = useCallback(
    (action: 'confirm' | 'cancel') => {
      if (closing) return;
      setClosing(true);
      setTimeout(() => {
        if (action === 'confirm') {
          onConfirm();
        } else {
          onCancel();
        }
      }, 200);
    },
    [closing, onConfirm, onCancel]
  );

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose('cancel');
    };
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [handleClose]);

  return (
    <div
      className={`${styles.overlay}${closing ? ' ' + styles.closing : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        handleClose('cancel');
      }}
    >
      <div
        className={`${styles.modal}${closing ? ' ' + styles.closing : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <p className={styles.message}>{message}</p>
        <div className={styles.actions}>
          <button className={styles.btnCancel} onClick={() => handleClose('cancel')}>
            取消
          </button>
          <button className={styles.btnConfirm} onClick={() => handleClose('confirm')}>
            确定
          </button>
        </div>
      </div>
    </div>
  );
}
