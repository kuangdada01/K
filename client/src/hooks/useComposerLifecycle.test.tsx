/**
 * ============================================================
 * 发帖弹窗生命周期 Hook 测试（useComposerLifecycle）
 * ============================================================
 * 这里锁的是「历史条目记账」这一类**只在特定时序下才出错**的行为，
 * 它曾让 e2e 的写路径用例假失败（发布成功后页面退到 about:blank）。
 *
 * 被钉死的契约：
 * 1. 挂载占用一条历史条目（返回键先关弹窗，而不是离开页面）
 * 2. 卸载/关闭**恰好归还一次**（不多退、不少退）
 * 3. ★ StrictMode 的「挂载 → 卸载 → 再挂载」只占一条、且不发生 back
 *    （旧实现在这里 push→back→push，back 的 popstate 迟到会吞掉新条目，
 *     导致之后关闭时多退一条）
 * 4. ★ 条目已被丢弃（history.state 不再是本 hook 的）时不再 back —— 否则多退一条
 * 5. 占用时保留 React Router 写在 history.state 里的 { idx } 记账
 * 6. 用户自己按返回键后，关闭时不再多退一条
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useComposerLifecycle, __resetComposerHistoryForTests } from './useComposerLifecycle';

/** history 埋点：模拟浏览器行为（pushState 更新当前条目的 state，back 回到上一条） */
let pushes: unknown[] = [];
let backs = 0;
/** 当前历史条目的 state（模拟 history.state） */
let currentState: unknown = null;

beforeEach(() => {
  __resetComposerHistoryForTests();
  pushes = [];
  backs = 0;
  currentState = null;
  // jsdom 的 history 不实现导航，这里替换成可观测的替身
  vi.spyOn(window.history, 'state', 'get').mockImplementation(() => currentState);
  vi.spyOn(window.history, 'pushState').mockImplementation((state: unknown) => {
    pushes.push(state);
    currentState = state;
  });
  vi.spyOn(window.history, 'back').mockImplementation(() => {
    backs += 1;
    // 回到上一条（不含本 hook 的 composer 标记），并同步派发 popstate 驱动 hook 的处理器
    currentState = { idx: 0 };
    window.dispatchEvent(new PopStateEvent('popstate', { state: currentState }));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const opts = (over: Partial<Parameters<typeof useComposerLifecycle>[0]> = {}) => ({
  hasContent: false,
  onConfirmDiscard: vi.fn(),
  closeCreate: vi.fn(),
  ...over,
});

/** 让「归还排期」（setTimeout 0）与关闭动画（200ms）跑完 */
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 250));
  });

describe('useComposerLifecycle：历史条目记账', () => {
  it('挂载占用一条历史条目，并保留 React Router 的 state 记账', () => {
    currentState = { idx: 3, key: 'abc' };
    renderHook(() => useComposerLifecycle(opts()));

    expect(pushes).toHaveLength(1);
    // 保留 idx/key（覆盖成 null 会让路由的历史记账与浏览器失同步）
    expect(pushes[0]).toMatchObject({ idx: 3, key: 'abc', composer: true });
  });

  it('★ StrictMode「挂载 → 卸载 → 再挂载」：只占一条、且不发生 back', () => {
    const { unmount } = renderHook(() => useComposerLifecycle(opts()));
    // StrictMode 的模拟卸载 + 再挂载（同一实例，紧随其后）
    unmount();
    renderHook(() => useComposerLifecycle(opts()));

    expect(pushes).toHaveLength(1); // 沿用同一条目，不重复压入
    expect(backs).toBe(0); // 也不归还 —— 旧实现这里会 back()，进而吞掉新条目
  });

  it('关闭时恰好归还一次（不多退）', async () => {
    const { result } = renderHook(() => useComposerLifecycle(opts()));
    expect(pushes).toHaveLength(1);

    act(() => result.current.handleClose());
    await flush();
    expect(backs).toBe(1);

    // 卸载兜底不应再退一次
    act(() => result.current.handleClose());
    await flush();
    expect(backs).toBe(1);
  });

  it('卸载时归还（弹窗被外部直接关闭）', async () => {
    const { unmount } = renderHook(() => useComposerLifecycle(opts()));
    unmount();
    await flush();
    expect(backs).toBe(1);
  });

  it('★ 条目已被丢弃时不再 back（否则多退一条、把用户弹到上一页）', async () => {
    const { result } = renderHook(() => useComposerLifecycle(opts()));
    // 模拟：条目被浏览器丢弃/弹窗期间发生了别的导航，当前 state 不再是本 hook 压入的那条
    currentState = { idx: 0 };

    act(() => result.current.handleClose());
    await flush();

    expect(backs).toBe(0);
  });

  it('用户自己按返回键消费条目后，关闭时不再多退一条', async () => {
    const closeCreate = vi.fn();
    const { result } = renderHook(() => useComposerLifecycle(opts({ closeCreate })));

    // 用户按浏览器返回键：条目被浏览器消费，弹窗走放弃流程关闭
    currentState = { idx: 0 };
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: currentState }));
    });
    // 无内容 → 直接关闭（进入 200ms 关闭动画）
    expect(result.current.closing).toBe(true);

    await flush();
    expect(backs).toBe(0); // 条目已被用户消费，不应再归还
    expect(closeCreate).toHaveBeenCalled();
  });

  it('有内容时返回键弹放弃确认，确认后才关闭并只归还一次', async () => {
    const onConfirmDiscard = vi.fn();
    const { result } = renderHook(() => useComposerLifecycle(opts({ hasContent: true, onConfirmDiscard })));

    act(() => {
      result.current.handleDiscard();
    });
    expect(result.current.showDiscardConfirm).toBe(true);
    expect(backs).toBe(0);

    act(() => result.current.confirmDiscard());
    await flush();
    expect(onConfirmDiscard).toHaveBeenCalledTimes(1);
    expect(backs).toBe(1);
  });

  it('ESC 有内容时先弹确认，再次 ESC 取消', () => {
    const { result } = renderHook(() => useComposerLifecycle(opts({ hasContent: true })));

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(result.current.showDiscardConfirm).toBe(true);

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(result.current.showDiscardConfirm).toBe(false);
    expect(backs).toBe(0);
  });
});
