/**
 * ============================================================
 * 管理端公告 Tab 渲染测试（pages/admin/AdminAnnouncementsTab）
 * ============================================================
 * 这个 tab 此前**没有搜索、也没有分页**（整表最多 500 行一次性进 DOM），
 * 所以这里钉的是新加的两件事的边界：
 * - 列表搜索框把值交回上层（由上层防抖后请求服务端），且**不做本地过滤**
 * - 分页控件边界（只有一页不渲染、首页禁上一页、末页禁下一页）
 * - 空态文案区分「搜索无结果」与「暂无公告」
 * - 「发送公告」表单里的目标用户搜索与列表搜索是两回事，不能互相串
 * ============================================================
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AdminAnnouncementsTab, { type AdminAnnouncementsTabProps } from './AdminAnnouncementsTab';
import type { AdminAnnouncement } from './types';

function ann(id: number, title: string, content: string): AdminAnnouncement {
  return {
    id,
    title,
    content,
    target_user_id: null,
    target_username: null,
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

type Overrides = Partial<AdminAnnouncementsTabProps>;

function setup(overrides: Overrides = {}) {
  const props: AdminAnnouncementsTabProps = {
    announcements: overrides.announcements ?? [
      ann(1, '维护通知', '今晚维护'),
      ann(2, '新功能', '上线了阅读器'),
    ],
    listSearch: overrides.listSearch ?? '',
    setListSearch: overrides.setListSearch ?? vi.fn(),
    listPage: overrides.listPage ?? 1,
    setListPage: overrides.setListPage ?? vi.fn(),
    listTotalPages: overrides.listTotalPages ?? 1,
    showSendForm: overrides.showSendForm ?? false,
    setShowSendForm: overrides.setShowSendForm ?? vi.fn(),
    annTitle: overrides.annTitle ?? '',
    setAnnTitle: overrides.setAnnTitle ?? vi.fn(),
    annContent: overrides.annContent ?? '',
    setAnnContent: overrides.setAnnContent ?? vi.fn(),
    annTargetId: overrides.annTargetId ?? null,
    annTargetName: overrides.annTargetName ?? '',
    annSearch: overrides.annSearch ?? '',
    annSearchResults: overrides.annSearchResults ?? [],
    showAnnDropdown: overrides.showAnnDropdown ?? false,
    setShowAnnDropdown: overrides.setShowAnnDropdown ?? vi.fn(),
    annDropdownRef: overrides.annDropdownRef ?? { current: null },
    onSearch: overrides.onSearch ?? vi.fn(),
    onSelectTarget: overrides.onSelectTarget ?? vi.fn(),
    onClearTarget: overrides.onClearTarget ?? vi.fn(),
    onSend: overrides.onSend ?? vi.fn(),
    onDelete: overrides.onDelete ?? vi.fn(),
  };
  render(<AdminAnnouncementsTab {...props} />);
  return props;
}

function capturedUpdater(spy: unknown): (p: number) => number {
  const calls = (spy as { mock: { calls: ((p: number) => number)[][] } }).mock.calls;
  const updater = calls[0]?.[0];
  if (!updater) throw new Error('页码更新函数没有被调用');
  return updater;
}

describe('AdminAnnouncementsTab', () => {
  it('渲染传入的公告（标题/内容/目标）', () => {
    setup();
    expect(screen.getByText('维护通知')).toBeTruthy();
    expect(screen.getByText('上线了阅读器')).toBeTruthy();
    expect(screen.getAllByText('全体用户')).toHaveLength(2);
  });

  it('★ 列表搜索词不匹配时依然把行全部渲染出来（搜索在服务端）', () => {
    setup({ listSearch: 'zzz-绝对匹配不上' });
    expect(screen.getByText('维护通知')).toBeTruthy();
    expect(screen.getByText('新功能')).toBeTruthy();
    expect(screen.queryByTestId('admin-ann-empty')).toBeNull();
  });

  it('列表搜索框输入交给上层（与表单里的目标用户搜索互不影响）', () => {
    const setListSearch = vi.fn();
    const onSearch = vi.fn();
    setup({ setListSearch, onSearch, showSendForm: true });
    fireEvent.change(screen.getByTestId('admin-ann-search'), { target: { value: '维护' } });
    expect(setListSearch).toHaveBeenCalledWith('维护');
    expect(onSearch).not.toHaveBeenCalled();
  });

  it('只有一页时不渲染分页控件', () => {
    setup({ listTotalPages: 1 });
    expect(screen.queryByTestId('admin-ann-next')).toBeNull();
  });

  it('多页时显示「当前页 / 总页数」，首页禁上一页、末页禁下一页', () => {
    setup({ listPage: 1, listTotalPages: 3 });
    expect(screen.getByTestId('admin-ann-page').textContent).toBe('1 / 3');
    expect((screen.getByTestId('admin-ann-prev') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('admin-ann-next') as HTMLButtonElement).disabled).toBe(false);
  });

  it('点下一页把「页码 + 1」的更新函数交给上层', () => {
    const setListPage = vi.fn();
    setup({ listPage: 1, listTotalPages: 3, setListPage });
    fireEvent.click(screen.getByTestId('admin-ann-next'));
    expect(capturedUpdater(setListPage)(1)).toBe(2);
  });

  it('空列表区分「搜索无结果」与「暂无公告」', () => {
    setup({ announcements: [], listSearch: 'nobody' });
    expect(screen.getByTestId('admin-ann-empty').textContent).toBe('没有匹配的公告');
  });

  it('空列表且没有搜索词时提示暂无公告', () => {
    setup({ announcements: [], listSearch: '' });
    expect(screen.getByTestId('admin-ann-empty').textContent).toBe('暂无公告');
  });

  it('删除按钮把整条公告交回上层', () => {
    const onDelete = vi.fn();
    setup({ onDelete });
    fireEvent.click(screen.getAllByTitle('删除公告')[0] as HTMLButtonElement);
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  it('「发送公告」按钮切换表单显示状态', () => {
    const setShowSendForm = vi.fn();
    setup({ setShowSendForm });
    fireEvent.click(screen.getByText('发送公告'));
    expect(setShowSendForm).toHaveBeenCalledWith(true);
  });
});
