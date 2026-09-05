/**
 * ============================================================
 * 评论树纯逻辑（lib/comments）
 * ============================================================
 * 从 PostDetail 抽出的可测试纯函数：
 * - 初始折叠集合（含高亮评论的祖先展开）
 * - 回复计数（全部后代）
 * - 可见评论扁平列表（折叠线程剪枝）
 */

import type { Comment } from '../types';

/** 计算初始折叠集合：折叠所有"有回复的顶级评论"；若指定高亮评论，展开其祖先链 */
export function computeInitialCollapsedIds(
  comments: Comment[],
  highlightCommentId?: number | null
): Set<number> {
  const collapsedIds = new Set<number>(
    comments
      .filter((c) => !c.parent_id && comments.some((r) => r.parent_id === c.id))
      .map((c) => Number(c.id))
  );

  if (highlightCommentId) {
    const targetId = Number(highlightCommentId);
    const expandAncestors = (commentId: number): void => {
      const comment = comments.find((c) => Number(c.id) === commentId);
      if (!comment || !comment.parent_id) return;
      collapsedIds.delete(Number(comment.parent_id));
      expandAncestors(Number(comment.parent_id));
    };
    expandAncestors(targetId);
  }

  return collapsedIds;
}

/** 某条评论的全部后代回复数量 */
export function countReplies(comments: Comment[], parentId: number): number {
  let count = 0;
  const walk = (id: number): void => {
    const replies = comments.filter((c) => c.parent_id === id);
    count += replies.length;
    replies.forEach((r) => walk(r.id));
  };
  walk(parentId);
  return count;
}

/** 可见评论条目 */
export interface VisibleComment {
  comment: Comment;
  isReply: boolean;
  /** 祖先线程被折叠时置位（渲染时跳过） */
  parentCollapsed?: boolean;
  isCollapsed: boolean;
  hasReplies: boolean;
  replyCount: number;
}

/**
 * 构建可见评论扁平列表（先父后回复，递归所有层级）
 * 折叠线程的回复项返回 null（渲染跳过，与原实现一致）
 */
export function buildVisibleComments(
  comments: Comment[],
  collapsedReplies: Set<number>
): (VisibleComment | null)[] {
  const repliesMap = new Map<number, Comment[]>();
  comments.forEach((c) => {
    if (c.parent_id) {
      const list = repliesMap.get(c.parent_id) || [];
      list.push(c);
      repliesMap.set(c.parent_id, list);
    }
  });

  const flatList: VisibleComment[] = [];
  const flattenReplies = (parentId: number, isParentCollapsed: boolean): void => {
    (repliesMap.get(parentId) || []).forEach((r) => {
      flatList.push({
        comment: r,
        isReply: true,
        parentCollapsed: isParentCollapsed,
        isCollapsed: collapsedReplies.has(r.id),
        hasReplies: repliesMap.has(r.id),
        replyCount: 0,
      });
      flattenReplies(r.id, isParentCollapsed || collapsedReplies.has(parentId));
    });
  };

  comments
    .filter((c) => !c.parent_id)
    .forEach((c) => {
      const hasReplies = repliesMap.has(c.id);
      const isCollapsed = collapsedReplies.has(c.id);
      flatList.push({
        comment: c,
        isReply: false,
        isCollapsed,
        hasReplies,
        replyCount: 0,
      });
      if (hasReplies) {
        flattenReplies(c.id, isCollapsed);
      }
    });

  return flatList.map((item) => {
    if (item.parentCollapsed) return null;
    return {
      ...item,
      replyCount: item.hasReplies ? countReplies(comments, item.comment.id) : 0,
    };
  });
}
