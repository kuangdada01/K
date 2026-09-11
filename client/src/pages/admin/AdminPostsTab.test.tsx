/**
 * ============================================================
 * 管理端帖子 Tab 渲染测试（pages/admin/AdminPostsTab）
 * ============================================================
 * 与用户 tab 同一个「容易被改回去」的点：搜索**不再本地过滤**。
 * 老实现是 `posts.filter(...)`，而 props 里的 `posts` 只有**当前这一页**，
 * 所以搜别的页的帖子必然空表。谁把 filter 加回来，这里就会红。
 *
 * 另外覆盖分页控件边界（这个 tab 本来就有分页）与空态文案。
 * ============================================================
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AdminPostsTab, { type AdminPostsTabProps } from './AdminPostsTab';
import type { AdminPost } from './types';

function post(id: number, username: string, description: string): AdminPost {
  return {
    id,
    user_id: id * 10,
    username,
    avatar: null,
    image_url: '[]',
    images: [],
    description,
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

type Overrides = Partial<AdminPostsTabProps>;

function setup(overrides: Overrides = {}) {
  const props: AdminPostsTabProps = {
    posts: overrides.posts ?? [post(1, 'alice', '第一篇'), post(2, 'bob', '第二篇')],
    postSearch: overrides.postSearch ?? '',
    setPostSearch: overrides.setPostSearch ?? vi.fn(),
    postPage: overrides.postPage ?? 1,
    setPostPage: overrides.setPostPage ?? vi.fn(),
    postTotal: overrides.postTotal ?? 1,
    onDelete: overrides.onDelete ?? vi.fn(),
    onOpenDetail: overrides.onOpenDetail ?? vi.fn(),
  };
  render(<AdminPostsTab {...props} />);
  return props;
}

/** 从「页码更新函数」的调用里取出更新函数（组件用的是 setState 的函数式写法） */
function capturedUpdater(spy: unknown): (p: number) => number {
  const calls = (spy as { mock: { calls: ((p: number) => number)[][] } }).mock.calls;
  const updater = calls[0]?.[0];
  if (!updater) throw new Error('页码更新函数没有被调用');
  return updater;
}

describe('AdminPostsTab', () => {
  it('渲染传入的行（作者/描述）', () => {
    setup();
    expect(screen.getByText('alice')).toBeTruthy();
    expect(screen.getByText('第二篇')).toBeTruthy();
  });

  it('★ 搜索词不匹配时依然把行全部渲染出来（搜索已在服务端，没有本地过滤）', () => {
    setup({ postSearch: 'zzz-绝对匹配不上' });
    expect(screen.getByText('alice')).toBeTruthy();
    expect(screen.getByText('bob')).toBeTruthy();
    expect(screen.queryByTestId('admin-posts-empty')).toBeNull();
  });

  it('搜索框输入把新值交给上层（由上层防抖后请求服务端）', () => {
    const setPostSearch = vi.fn();
    setup({ setPostSearch });
    fireEvent.change(screen.getByTestId('admin-post-search'), { target: { value: 'alice' } });
    expect(setPostSearch).toHaveBeenCalledWith('alice');
  });

  it('只有一页时不渲染分页控件', () => {
    setup({ postTotal: 1 });
    expect(screen.queryByTestId('admin-posts-next')).toBeNull();
  });

  it('多页时显示「当前页 / 总页数」，第 1 页禁用上一页', () => {
    setup({ postPage: 1, postTotal: 3 });
    expect(screen.getByTestId('admin-posts-page').textContent).toBe('1 / 3');
    expect((screen.getByTestId('admin-posts-prev') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('admin-posts-next') as HTMLButtonElement).disabled).toBe(false);
  });

  it('末页禁用下一页', () => {
    setup({ postPage: 3, postTotal: 3 });
    expect((screen.getByTestId('admin-posts-next') as HTMLButtonElement).disabled).toBe(true);
  });

  it('点下一页把「页码 + 1」的更新函数交给上层', () => {
    const setPostPage = vi.fn();
    setup({ postPage: 2, postTotal: 3, setPostPage });
    fireEvent.click(screen.getByTestId('admin-posts-next'));
    expect(setPostPage).toHaveBeenCalledTimes(1);
    expect(capturedUpdater(setPostPage)(2)).toBe(3);
  });

  it('打开详情回调带上帖子 id', () => {
    const onOpenDetail = vi.fn();
    setup({ onOpenDetail });
    fireEvent.click(screen.getAllByTestId('admin-post-thumb')[0] as HTMLImageElement);
    expect(onOpenDetail).toHaveBeenCalledWith(1);
  });

  it('空列表区分「搜索无结果」与「暂无帖子」', () => {
    setup({ posts: [], postSearch: 'nobody' });
    expect(screen.getByTestId('admin-posts-empty').textContent).toBe('没有匹配的帖子');
  });

  it('空列表且没有搜索词时提示暂无帖子', () => {
    setup({ posts: [], postSearch: '' });
    expect(screen.getByTestId('admin-posts-empty').textContent).toBe('暂无帖子');
  });
});
