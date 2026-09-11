/**
 * ============================================================
 * 无分页列表硬上限（P1-8 / P2-34）回归测试
 * ============================================================
 * 覆盖:
 * - `capRows` 的边界语义（恰好等于上限时**不能**误报 has_more）
 * - `probeLimit` = 上限 + 1
 * - 收藏/转发/粉丝/关注/公告/评论这些原来无 LIMIT 的查询，
 *   现在最多物化 上限+1 行并正确给出 has_more
 * - 未读数走独立 COUNT，不受列表上限影响（侧边栏徽标不能因截断而偏小）
 *
 * 这些断言是**契约**：一旦有人把 LIMIT 去掉或把 has_more 写死，
 * 这里必须红。上限值本身只断言是正整数，允许调参。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createMemoryDb } from './helpers/memdb';
import { setDbForTests, resetDbForTests } from '../src/db/connection';
import { HARD_LIST_CAP, HARD_COMMENT_CAP, capRows, probeLimit } from '../src/lib/listLimits';
import * as adminRepo from '../src/repositories/admin.repo';
import * as friendRepo from '../src/repositories/friend.repo';
import * as notifRepo from '../src/repositories/notification.repo';
import * as commentRepo from '../src/repositories/comment.repo';

let db: InstanceType<typeof Database>;
let seq = 0;

/** 建一个用户，返回 id（用户名/邮箱唯一，避免相互干扰） */
function makeUser(role = 'user'): number {
  seq += 1;
  const info = db
    .prepare("INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, 'x', ?)")
    .run(`cap_u${seq}`, `cap_u${seq}@test.com`, role);
  return Number(info.lastInsertRowid);
}

function makePost(userId: number): number {
  const info = db
    .prepare("INSERT INTO posts (user_id, image_url, description) VALUES (?, '[]', 'cap')")
    .run(userId);
  return Number(info.lastInsertRowid);
}

function makeAnnouncement(fromUserId: number, title: string, targetUserId: number | null = null): number {
  const info = db
    .prepare('INSERT INTO announcements (title, content, target_user_id, from_user_id) VALUES (?, ?, ?, ?)')
    .run(title, 'cap', targetUserId, fromUserId);
  return Number(info.lastInsertRowid);
}

beforeEach(() => {
  seq = 0;
  db = createMemoryDb();
  setDbForTests(db);
});

afterEach(() => {
  resetDbForTests();
  db.close();
});

describe('capRows 边界语义', () => {
  it('行数小于上限：原样返回且 has_more=false', () => {
    const rows = [1, 2, 3];
    const r = capRows(rows, 5);
    expect(r.rows).toEqual([1, 2, 3]);
    expect(r.has_more).toBe(false);
  });

  it('行数**恰好**等于上限：has_more=false（探测多取一行的意义所在）', () => {
    const r = capRows([1, 2, 3], 3);
    expect(r.rows).toHaveLength(3);
    expect(r.has_more).toBe(false);
  });

  it('行数超过上限：截断到上限且 has_more=true', () => {
    const r = capRows([1, 2, 3, 4], 3);
    expect(r.rows).toEqual([1, 2, 3]);
    expect(r.has_more).toBe(true);
  });

  it('空数组：has_more=false', () => {
    expect(capRows([], 3)).toEqual({ rows: [], has_more: false });
  });

  it('probeLimit 取上限 + 1', () => {
    expect(probeLimit(0)).toBe(1);
    expect(probeLimit(500)).toBe(501);
  });

  it('上限常量是正整数（调参合法，但必须有上限）', () => {
    for (const cap of [HARD_LIST_CAP, HARD_COMMENT_CAP]) {
      expect(Number.isInteger(cap)).toBe(true);
      expect(cap).toBeGreaterThan(0);
    }
  });
});

describe('管理端列表上限', () => {
  it('listUsers 截断并标记 has_more', () => {
    makeUser();
    makeUser();
    makeUser();

    const capped = adminRepo.listUsers(2);
    expect(capped.rows).toHaveLength(2);
    expect(capped.has_more).toBe(true);

    const exact = adminRepo.listUsers(3);
    expect(exact.rows).toHaveLength(3);
    expect(exact.has_more).toBe(false);
  });

  it('listAllAnnouncements 截断并标记 has_more', () => {
    const admin = makeUser('admin');
    makeAnnouncement(admin, 'a1');
    makeAnnouncement(admin, 'a2');

    const capped = adminRepo.listAllAnnouncements(1);
    expect(capped.rows).toHaveLength(1);
    expect(capped.has_more).toBe(true);

    expect(adminRepo.listAllAnnouncements(2).has_more).toBe(false);
  });
});

describe('社交列表上限', () => {
  it('listFollowers 截断，且 is_following 仍按 viewer 计算', () => {
    const target = makeUser();
    const viewer = makeUser();
    const a = makeUser();
    const b = makeUser();
    const c = makeUser();
    friendRepo.follow(a, target);
    friendRepo.follow(b, target);
    friendRepo.follow(c, target);

    const capped = friendRepo.listFollowers(target, viewer, 2);
    expect(capped.rows).toHaveLength(2);
    expect(capped.has_more).toBe(true);
    expect(capped.rows.map((r) => r.username)).toEqual(['cap_u3', 'cap_u4']);

    // viewer 关注了 a，则 a 出现在粉丝列表时应标记已关注
    friendRepo.follow(viewer, a);
    const mine = friendRepo.listFollowers(target, viewer, 5);
    expect(mine.has_more).toBe(false);
    expect(mine.rows.find((r) => r.username === 'cap_u3')?.is_following).toBe(1);
    expect(mine.rows.find((r) => r.username === 'cap_u4')?.is_following).toBe(0);
  });

  it('listFollowing 截断并标记 has_more', () => {
    const source = makeUser();
    const viewer = makeUser();
    friendRepo.follow(source, makeUser());
    friendRepo.follow(source, makeUser());
    friendRepo.follow(source, makeUser());

    const capped = friendRepo.listFollowing(source, viewer, 2);
    expect(capped.rows).toHaveLength(2);
    expect(capped.has_more).toBe(true);
    expect(friendRepo.listFollowing(source, viewer, 3).has_more).toBe(false);
  });
});

describe('公告列表上限与未读数', () => {
  it('listAnnouncements 截断，但未读数来自独立 COUNT 因而不偏小', () => {
    const admin = makeUser('admin');
    const uid = makeUser();
    for (let i = 0; i < 3; i += 1) makeAnnouncement(admin, `broadcast-${i}`);

    const capped = notifRepo.listAnnouncements(uid, 2);
    expect(capped.rows).toHaveLength(2);
    expect(capped.has_more).toBe(true);

    // 关键：徽标数字不能被列表上限截断
    expect(notifRepo.countUnreadAnnouncements(uid)).toBe(3);
  });

  it('定向公告只对该用户可见，且被已读后未读数下降', () => {
    const admin = makeUser('admin');
    const uid = makeUser();
    const other = makeUser();
    const targeted = makeAnnouncement(admin, 'just-for-you', uid);

    expect(notifRepo.listAnnouncements(uid).rows.map((r) => r.title)).toContain('just-for-you');
    expect(notifRepo.listAnnouncements(other).rows.map((r) => r.title)).not.toContain('just-for-you');
    expect(notifRepo.countUnreadAnnouncements(uid)).toBe(1);

    notifRepo.markAnnouncementRead(targeted, uid);
    expect(notifRepo.countUnreadAnnouncements(uid)).toBe(0);
  });
});

describe('评论列表上限', () => {
  it('listComments / listCommentsForPost 截断到 HARD_COMMENT_CAP 并标记 has_more', () => {
    const uid = makeUser();
    const postId = makePost(uid);
    for (let i = 0; i < 3; i += 1) {
      db.prepare('INSERT INTO comments (user_id, post_id, content) VALUES (?, ?, ?)').run(
        uid,
        postId,
        `c${i}`
      );
    }

    const capped = commentRepo.listComments(postId, undefined, 2);
    expect(capped.rows).toHaveLength(2);
    expect(capped.has_more).toBe(true);

    const exact = commentRepo.listCommentsForPost(postId, 3);
    expect(exact.rows).toHaveLength(3);
    expect(exact.has_more).toBe(false);
  });
});
