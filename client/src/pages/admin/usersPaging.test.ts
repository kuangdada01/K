/**
 * ============================================================
 * 管理端用户列表分页纯函数测试（pages/admin/usersPaging）
 * ============================================================
 * 这两处算错了不会报错、只会「看起来有点怪」，所以用单测钉住：
 * - 总页数的边界（0 行不能显示成 1 页；恰好整页不能虚增一页）
 * - 乐观删除后页码与总数要跟着变（否则第二页删空了页脚还说有下一页）
 * - 删一个不在当前页的 id 不能把总数减掉
 */

import { describe, it, expect } from 'vitest';
import {
  ADMIN_USERS_PAGE_SIZE,
  pageCount,
  patchUserInPage,
  removeUserFromPage,
  type AdminUsersPage,
} from './usersPaging';
import type { AdminUser } from './types';

function user(id: number): AdminUser {
  return {
    id,
    username: `u${id}`,
    email: `u${id}@test.com`,
    avatar: null,
    bio: '',
    role: 'user',
    created_at: '2026-01-01T00:00:00.000Z',
    post_count: 0,
    banned_until: null,
  };
}

function page(ids: number[], total: number): AdminUsersPage {
  return { users: ids.map(user), total, totalPages: pageCount(total) };
}

describe('pageCount', () => {
  it('每页条数来自一个常量（与服务端默认值对齐）', () => {
    expect(ADMIN_USERS_PAGE_SIZE).toBe(20);
  });

  it('0 行 → 0 页（不能显示成 1 页）', () => {
    expect(pageCount(0)).toBe(0);
  });

  it('不足一页 → 1 页；恰好整页 → 不虚增', () => {
    expect(pageCount(1)).toBe(1);
    expect(pageCount(19)).toBe(1);
    expect(pageCount(20)).toBe(1);
    expect(pageCount(21)).toBe(2);
    expect(pageCount(40)).toBe(2);
    expect(pageCount(41)).toBe(3);
  });

  it('limit 可覆盖，也能容忍脏入参', () => {
    expect(pageCount(30, 10)).toBe(3);
    expect(pageCount(5, 0)).toBe(0);
    expect(pageCount(-1)).toBe(0);
    expect(pageCount(Number.NaN)).toBe(0);
  });
});

describe('removeUserFromPage', () => {
  it('摘掉该行并把总数与页数一起减', () => {
    const before = page([21], 21); // 第 2 页只剩 1 行
    const after = removeUserFromPage(before, 21);
    expect(after.users).toEqual([]);
    expect(after.total).toBe(20);
    expect(after.totalPages).toBe(1); // 页脚随之从 2 页变成 1 页
  });

  it('删掉之后还有数据时，其它行不受影响', () => {
    const after = removeUserFromPage(page([1, 2, 3], 23), 2);
    expect(after.users.map((u) => u.id)).toEqual([1, 3]);
    expect(after.total).toBe(22);
    expect(after.totalPages).toBe(2);
  });

  it('★ 删一个不在当前页的 id：原样返回，不能顺手减总数', () => {
    const before = page([1, 2], 30);
    expect(removeUserFromPage(before, 999)).toBe(before);
  });

  it('总数不会减成负数', () => {
    const after = removeUserFromPage(page([1], 0), 1);
    expect(after.total).toBe(0);
    expect(after.totalPages).toBe(0);
  });
});

describe('patchUserInPage', () => {
  it('只改命中的那一行（封禁就地生效，不重取列表）', () => {
    const before = page([1, 2, 3], 3);
    const after = patchUserInPage(before, 2, { banned_until: '2027-01-01T00:00:00.000Z' });
    expect(after.users.map((u) => u.banned_until)).toEqual([null, '2027-01-01T00:00:00.000Z', null]);
    // 未命中的行保持同一引用（渲染时可以跳过），命中的那行是**新对象**
    expect(after.users[0]).toBe(before.users[0]);
    expect(after.users[2]).toBe(before.users[2]);
    expect(after.users[1]).not.toBe(before.users[1]);
    expect(after.total).toBe(3);
  });

  it('解封即把 banned_until 置回 null', () => {
    const banned = patchUserInPage(page([1], 1), 1, { banned_until: '2027-01-01T00:00:00.000Z' });
    expect(patchUserInPage(banned, 1, { banned_until: null }).users[0]?.banned_until).toBeNull();
  });
});
