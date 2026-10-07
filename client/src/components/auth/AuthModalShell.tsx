/**
 * ============================================================
 * 认证弹窗外壳 (AuthModalShell)
 * ============================================================
 * 登录/注册/忘记密码弹窗的模态外壳：
 * - overlay 点击关闭（先 stopPropagation 再触发 onClose）
 * - modal 内容点击 stopPropagation，不冒泡触发关闭
 * - ESC 键关闭（onClose 为关闭感知的 handleClose，closing 期间自动忽略）
 * - closing 时叠加 .closing class，由 CSS 的 loginFadeOut/loginScaleOut
 *   播放 200ms 退场动画；200ms 计时由调用方的 handleClose 负责
 * - 入场 fadeIn/scaleIn 动画由 CSS keyframes 提供
 * ============================================================
 */

import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';
import styles from '../LoginPrompt.module.css';

interface AuthModalShellProps {
  closing: boolean;
  onClose: () => void;
  children: ReactNode;
}

export default function AuthModalShell({ closing, onClose, children }: AuthModalShellProps) {
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  return (
    <div
      className={`${styles.overlay}${closing ? ` ${styles.closing}` : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        className={`${styles.modal}${closing ? ` ${styles.closing}` : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <button className={styles.close} data-back onClick={onClose}>
          <X size={18} />
        </button>
        {children}
      </div>
    </div>
  );
}
