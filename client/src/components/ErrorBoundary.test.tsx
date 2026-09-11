/**
 * ============================================================
 * 错误边界测试（components/ErrorBoundary —— P1-6）
 * ============================================================
 * 背景：全仓此前**没有任何 React 错误边界**，懒加载页面或全局弹层里任何一次
 * 渲染期异常都会让 React 卸载整棵树 —— 纯白页面、只能手动刷新、编辑内容一起丢。
 *
 * 覆盖:
 * - 子树渲染期异常 → 显示兜底 UI（而不是把异常抛给上层）
 * - 默认兜底带「重试」，点击后清错误状态并重新渲染子树
 * - 自定义 fallback 拿到 reset 与 error
 * - componentDidCatch 记录组件栈（便于线上定位）
 * - 未出错时零影响（直接透传 children）
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ErrorBoundary from './ErrorBoundary';

/** 受控抛错的子树：`shouldThrow` 为 true 时在渲染期抛 */
function Boom({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error('渲染炸了');
  return <div>正常内容</div>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
  it('未出错时直接透传子树（零影响）', () => {
    render(
      <ErrorBoundary>
        <Boom shouldThrow={false} />
      </ErrorBoundary>
    );
    expect(screen.getByText('正常内容')).toBeTruthy();
    expect(screen.queryByText('页面出错了')).toBeNull();
  });

  it('★ 子树渲染期异常 → 显示兜底 UI，而不是让整棵树崩掉', () => {
    // React 会把边界捕获的错误也打到 console.error：这里静音，避免污染测试输出
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Boom shouldThrow />
      </ErrorBoundary>
    );
    expect(screen.getByText('页面出错了')).toBeTruthy();
  });

  it('★ 点「重试」清错误状态并重新渲染子树（子树恢复后不再显示兜底）', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // 用一个可变开关模拟「同一个子树第二次渲染不再抛」
    let broken = true;
    function Flaky() {
      if (broken) throw new Error('首次渲染失败');
      return <div>恢复了</div>;
    }

    render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>
    );
    expect(screen.getByText('页面出错了')).toBeTruthy();

    broken = false;
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(screen.getByText('恢复了')).toBeTruthy();
    expect(screen.queryByText('页面出错了')).toBeNull();
  });

  it('自定义 fallback 收到 error 与 reset', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary
        label="CreatePost"
        fallback={({ error, reset }) => (
          <button type="button" onClick={reset}>
            {`崩了：${error.message}`}
          </button>
        )}
      >
        <Boom shouldThrow />
      </ErrorBoundary>
    );
    const btn = screen.getByRole('button');
    expect(btn.textContent).toBe('崩了：渲染炸了');
    // 点一下不该抛（reset 只是清状态；子树仍然抛 → 再次进入兜底）
    expect(() => fireEvent.click(btn)).not.toThrow();
  });

  it('★ componentDidCatch 记录 label 与组件栈（线上定位用）', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary label="EditPost">
        <Boom shouldThrow />
      </ErrorBoundary>
    );
    // React 自己也会往 console.error 打一条（格式串 '%o\n\n%s\n\n%s\n'），
    // 这里要挑出**本组件**打的那条：它以 '[ErrorBoundary:EditPost]' 开头
    const mine = spy.mock.calls.find((c) => String(c[0]).includes('[ErrorBoundary:EditPost]'));
    expect(mine, '应记录带 label 的错误日志').toBeDefined();
    // 第二个参数是 ErrorInfo（含 componentStack）
    const info = mine?.[2] as { componentStack?: string } | undefined;
    expect(typeof info?.componentStack).toBe('string');
  });
});
