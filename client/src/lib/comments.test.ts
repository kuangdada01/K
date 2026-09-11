/**
 * 评论树纯逻辑测试（lib/comments）
 * 覆盖：初始折叠集合、祖先链展开、后代计数、可见列表构建与折叠剪枝
 */
import { describe, it, expect } from 'vitest';
import { buildVisibleComments, computeInitialCollapsedIds, countReplies } from './comments';
import type { Comment } from '../types';

function makeComment(overrides: Partial<Comment> & Pick<Comment, 'id' | 'parent_id'>): Comment {
  return {
    user_id: 1,
    post_id: 1,
    content: `评论${overrides.id}`,
    created_at: '2026-01-01T00:00:00Z',
    username: 'user',
    avatar: null,
    like_count: 0,
    ...overrides,
  };
}

/** 测试树：c1 ← r1 ← rr1（三层）；c2（无回复）；c3 ← r3a、r3b（两条直接回复） */
const TREE: Comment[] = [
  makeComment({ id: 1, parent_id: null }),
  makeComment({ id: 2, parent_id: null }),
  makeComment({ id: 3, parent_id: null }),
  makeComment({ id: 11, parent_id: 1 }),
  makeComment({ id: 111, parent_id: 11 }),
  makeComment({ id: 31, parent_id: 3 }),
  makeComment({ id: 32, parent_id: 3 }),
];

describe('computeInitialCollapsedIds', () => {
  it('折叠所有有回复的顶级评论，无回复的不折叠', () => {
    const collapsed = computeInitialCollapsedIds(TREE);
    expect(collapsed).toEqual(new Set([1, 3]));
  });

  it('高亮深层回复时展开其全部祖先', () => {
    const collapsed = computeInitialCollapsedIds(TREE, 111);
    expect(collapsed).toEqual(new Set([3]));
  });

  it('高亮顶级评论不改变折叠集合', () => {
    const collapsed = computeInitialCollapsedIds(TREE, 2);
    expect(collapsed).toEqual(new Set([1, 3]));
  });

  it('高亮不存在的评论时不展开任何线程', () => {
    const collapsed = computeInitialCollapsedIds(TREE, 999);
    expect(collapsed).toEqual(new Set([1, 3]));
  });
});

describe('countReplies', () => {
  it('统计全部层级的后代数量', () => {
    expect(countReplies(TREE, 1)).toBe(2); // r1 + rr1
    expect(countReplies(TREE, 3)).toBe(2); // r3a + r3b
    expect(countReplies(TREE, 11)).toBe(1); // rr1
  });

  it('无回复的评论计数为 0', () => {
    expect(countReplies(TREE, 2)).toBe(0);
  });
});

describe('buildVisibleComments', () => {
  it('先父后回复按原顺序排列，含正确 replyCount', () => {
    const visible = buildVisibleComments(TREE, new Set());
    const nonNull = visible.filter((v) => v !== null);
    expect(nonNull.map((v) => v.comment.id)).toEqual([1, 11, 111, 2, 3, 31, 32]);
    const byId = new Map(nonNull.map((v) => [v.comment.id, v]));
    expect(byId.get(1)!.replyCount).toBe(2);
    expect(byId.get(11)!.isReply).toBe(true);
    expect(byId.get(111)!.replyCount).toBe(0);
    expect(byId.get(2)!.hasReplies).toBe(false);
  });

  it('折叠线程的回复项返回 null（渲染跳过），父项计数不受影响', () => {
    const visible = buildVisibleComments(TREE, new Set([1]));
    expect(visible[1]).toBeNull(); // r1 被折叠
    expect(visible[2]).toBeNull(); // rr1 被折叠
    expect(visible[0]!.comment.id).toBe(1);
    expect(visible[0]!.replyCount).toBe(2);
    // c3 线程不受 c1 折叠影响
    expect(visible[4]!.comment.id).toBe(3);
    expect(visible[5]!.comment.id).toBe(31);
  });

  it('顶级评论自身折叠时条目可见（isCollapsed 置位），其回复项被剪枝为 null', () => {
    const visible = buildVisibleComments(TREE, new Set([3]));
    expect(visible[4]!.isCollapsed).toBe(true);
    expect(visible[5]).toBeNull(); // 折叠的顶级评论，回复不进入可见列表
  });

  it('replyCount 与 countReplies 语义一致（深度/分叉树全量对照）', () => {
    // 深链 c1 ← r1 ← rr1 ← rrr1 与分叉 c3 ← {31, 32 ← 321}
    const tree: Comment[] = [
      makeComment({ id: 1, parent_id: null }),
      makeComment({ id: 11, parent_id: 1 }),
      makeComment({ id: 111, parent_id: 11 }),
      makeComment({ id: 1111, parent_id: 111 }),
      makeComment({ id: 3, parent_id: null }),
      makeComment({ id: 31, parent_id: 3 }),
      makeComment({ id: 32, parent_id: 3 }),
      makeComment({ id: 321, parent_id: 32 }),
    ];
    const byId = new Map(
      buildVisibleComments(tree, new Set())
        .filter((v) => v !== null)
        .map((v) => [v.comment.id, v])
    );
    for (const c of tree) {
      const expected = countReplies(tree, c.id);
      // 有回复的项才带计数；无回复的项恒为 0
      expect(byId.get(c.id)!.replyCount).toBe(c === tree[0] || expected > 0 ? expected : 0);
    }
    // 明确的关键值：后代是「全部层级」而非仅直接子级
    expect(byId.get(1)!.replyCount).toBe(3);
    expect(byId.get(11)!.replyCount).toBe(2);
    expect(byId.get(111)!.replyCount).toBe(1);
    expect(byId.get(3)!.replyCount).toBe(3);
    expect(byId.get(32)!.replyCount).toBe(1);
    expect(byId.get(321)!.replyCount).toBe(0);
  });

  it('大规模输入不退化：800 条评论的构建耗时受控（原 O(n²) 实现会显著放大）', () => {
    // 10 个顶级评论，每个挂 79 条直接回复 —— 总 800 条
    const big: Comment[] = [];
    for (let t = 1; t <= 10; t++) {
      big.push(makeComment({ id: t, parent_id: null }));
      for (let r = 1; r <= 79; r++) {
        big.push(makeComment({ id: t * 1000 + r, parent_id: t }));
      }
    }
    const started = performance.now();
    const visible = buildVisibleComments(big, new Set());
    const elapsed = performance.now() - started;

    expect(visible.length).toBe(800);
    // 阈值放得很宽（CI 慢机也不误报），只用于拦住回到 O(n²) 的退化：
    // 800 条在 O(n²) 下是 ~64 万次 filter，通常 >100ms
    expect(elapsed).toBeLessThan(150);
  });
});
