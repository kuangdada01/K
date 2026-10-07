/**
 * ============================================================
 * 管理端用户 Tab 渲染测试（pages/admin/AdminUsersTab）
 * ============================================================
 * 钉住两件**容易被改回去**的事：
 * - 搜索**不再本地过滤**：传进来的行必须原样渲染。老实现是
 *   `users.filter(...)`，谁把它加回来，这里的「搜索词不匹配也要显示」
 *   就会红 —— 本地过滤的毛病不是慢，而是超出上限的用户搜不到、也管不了。
 * - 分页控件的边界：第 1 页禁用「上一页」、末页禁用「下一页」、
 *   只有一页时不渲染控件、空列表要给出空态文案。
 * ============================================================
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AdminUsersTab, { type AdminUsersTabProps } from './AdminUsersTab';
import type { AdminUser } from './types';

function user(id: number, username: string, email: string): AdminUser {
  return {
    id,
    username,
    email,
    avatar: null,
    bio: '',
    role: 'user',
    created_at: '2026-01-01T00:00:00.000Z',
    post_count: 0,
    banned_until: null,
  };
}

type Overrides = Partial<AdminUsersTabProps>;

function setup(overrides: Overrides = {}) {
  // 显式逐项给默认值（不用展开可选属性 —— exactOptionalPropertyTypes 下
  // 展开会把每个字段变成 `T | undefined`，反而过不了类型检查）
  const props: AdminUsersTabProps = {
    users: overrides.users ?? [user(1, 'alice', 'alice@test.com'), user(2, 'bob', 'bob@test.com')],
    userSearch: overrides.userSearch ?? '',
    setUserSearch: overrides.setUserSearch ?? vi.fn(),
    userPage: overrides.userPage ?? 1,
    setUserPage: overrides.setUserPage ?? vi.fn(),
    userTotalPages: overrides.userTotalPages ?? 1,
    isBanned: overrides.isBanned ?? (() => false),
    onDelete: overrides.onDelete ?? vi.fn(),
    onUnban: overrides.onUnban ?? vi.fn(),
    onSetBanTarget: overrides.onSetBanTarget ?? vi.fn(),
    banTarget: overrides.banTarget ?? null,
    onBan: overrides.onBan ?? vi.fn(),
    pwTarget: overrides.pwTarget ?? null,
    setPwTarget: overrides.setPwTarget ?? vi.fn(),
    newPw: overrides.newPw ?? '',
    setNewPw: overrides.setNewPw ?? vi.fn(),
    onChangePw: overrides.onChangePw ?? vi.fn(),
  };
  render(<AdminUsersTab {...props} />);
  return props;
}

/** 从「页码更新函数」的调用里取出更新函数（组件用的是 setState 的函数式写法） */
function capturedUpdater(spy: unknown): (p: number) => number {
  const calls = (spy as { mock: { calls: ((p: number) => number)[][] } }).mock.calls;
  const first = calls[0];
  const updater = first?.[0];
  if (!updater) throw new Error('页码更新函数没有被调用');
  return updater;
}

describe('AdminUsersTab', () => {
  it('渲染传入的行（用户名/邮箱）', () => {
    setup();
    expect(screen.getByText('alice')).toBeTruthy();
    expect(screen.getByText('bob@test.com')).toBeTruthy();
  });

  it('★ 搜索词不匹配时依然把行全部渲染出来（搜索已在服务端，没有本地过滤）', () => {
    setup({ userSearch: 'zzz-绝对匹配不上' });
    expect(screen.getByText('alice')).toBeTruthy();
    expect(screen.getByText('bob')).toBeTruthy();
    expect(screen.queryByTestId('admin-users-empty')).toBeNull();
  });

  it('搜索框输入把新值交给上层（由上层防抖后请求服务端）', () => {
    const setUserSearch = vi.fn();
    setup({ setUserSearch });
    fireEvent.change(screen.getByTestId('admin-user-search'), { target: { value: 'alice' } });
    expect(setUserSearch).toHaveBeenCalledWith('alice');
  });

  it('只有一页时不渲染分页控件', () => {
    setup({ userTotalPages: 1 });
    expect(screen.queryByTestId('admin-users-next')).toBeNull();
    expect(screen.queryByTestId('admin-users-prev')).toBeNull();
  });

  it('多页时显示「当前页 / 总页数」，第 1 页禁用上一页', () => {
    setup({ userPage: 1, userTotalPages: 3 });
    expect(screen.getByTestId('admin-users-page').textContent).toBe('1 / 3');
    expect((screen.getByTestId('admin-users-prev') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('admin-users-next') as HTMLButtonElement).disabled).toBe(false);
  });

  it('末页禁用下一页', () => {
    setup({ userPage: 3, userTotalPages: 3 });
    expect((screen.getByTestId('admin-users-next') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('admin-users-prev') as HTMLButtonElement).disabled).toBe(false);
  });

  it('中间页两个方向都能点', () => {
    setup({ userPage: 2, userTotalPages: 3 });
    expect(screen.getByTestId('admin-users-page').textContent).toBe('2 / 3');
    expect((screen.getByTestId('admin-users-prev') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('admin-users-next') as HTMLButtonElement).disabled).toBe(false);
  });

  it('点下一页把「页码 + 1」的更新函数交给上层（与帖子管理同款语义）', () => {
    const setUserPage = vi.fn();
    setup({ userPage: 2, userTotalPages: 3, setUserPage });
    fireEvent.click(screen.getByTestId('admin-users-next'));
    expect(setUserPage).toHaveBeenCalledTimes(1);
    expect(capturedUpdater(setUserPage)(2)).toBe(3);
  });

  it('点上一页把「页码 - 1」的更新函数交给上层', () => {
    const setUserPage = vi.fn();
    setup({ userPage: 3, userTotalPages: 3, setUserPage });
    fireEvent.click(screen.getByTestId('admin-users-prev'));
    expect(capturedUpdater(setUserPage)(3)).toBe(2);
  });

  it('空列表区分「搜索无结果」与「暂无用户」', () => {
    setup({ users: [], userSearch: 'nobody' });
    expect(screen.getByTestId('admin-users-empty').textContent).toBe('没有匹配的用户');
  });

  it('空列表且没有搜索词时提示暂无用户', () => {
    setup({ users: [], userSearch: '' });
    expect(screen.getByTestId('admin-users-empty').textContent).toBe('暂无用户');
  });
});
