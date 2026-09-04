/**
 * ============================================================
 * 空状态组件 (EmptyState)
 * ============================================================
 * 统一的空内容占位（视觉样式与历史内联样式完全一致）。
 */

import { ReactNode } from 'react';

interface EmptyStateProps {
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export default function EmptyState({ title, children, className }: EmptyStateProps) {
  return (
    <div
      className={className}
      style={{ textAlign: 'center', padding: 60, color: 'var(--text-secondary)' }}
    >
      {title}
      {children}
    </div>
  );
}
