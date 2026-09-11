/**
 * ============================================================
 * 错误边界（components/ErrorBoundary）
 * ============================================================
 * 背景（P1-6）：全仓此前**没有任何 React 错误边界**
 * （grep `ErrorBoundary|componentDidCatch|getDerivedStateFromError` 只命中 `<img onError>`）。
 * 后果是：懒加载页面或全局弹层里任何一次渲染期异常，React 19 会卸载**整棵树**
 * —— 纯白页面、用户只能手动刷新、编辑中的内容一起丢。
 *
 * 用法（`fallback` 是渲染函数，拿到 `reset` 以便「重试」）：
 * ```tsx
 * <ErrorBoundary label="CreatePost" fallback={({ reset }) => <Panel onRetry={reset} />}>
 *   <CreatePost />
 * </ErrorBoundary>
 * ```
 *
 * 兜底 UI 刻意只用**既有**样式语言（`EmptyState` 的居中灰字 + 一个普通按钮），
 * 不引入新的视觉；正常路径零影响（未出错时本组件只做一次 children 透传）。
 *
 * 注意边界能力范围：它接得住**渲染期/生命周期**异常；事件处理器与异步代码里的异常
 * 不会走到这里 —— 那部分由 main.tsx 的 `onUncaughtError` 兜底记录（见该文件）。
 * ============================================================
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** 出错时的兜底 UI；`reset` 会清掉错误状态重新挂载子树 */
  fallback?: (args: { error: Error; reset: () => void }) => ReactNode;
  /** 日志标签（便于在控制台区分是哪一块崩了） */
  label?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 保留组件栈：没有它，线上只能看到一行 message，定位不到是哪棵子树
    console.error(`[ErrorBoundary${this.props.label ? `:${this.props.label}` : ''}] 渲染期异常`, error, info);
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback({ error, reset: this.reset });

    return (
      <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-secondary)' }}>
        <div>页面出错了</div>
        <div style={{ fontSize: 13, marginTop: 8, opacity: 0.8 }}>
          可以点下面的按钮重试；若反复出现，请刷新页面
        </div>
        <button
          type="button"
          onClick={this.reset}
          style={{
            marginTop: 16,
            padding: '6px 16px',
            borderRadius: 8,
            border: '1px solid var(--border-color, rgba(128,128,128,0.35))',
            background: 'transparent',
            color: 'inherit',
            cursor: 'pointer',
            fontSize: 13,
          }}
        >
          重试
        </button>
      </div>
    );
  }
}
