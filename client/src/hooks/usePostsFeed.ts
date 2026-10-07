/**
 * ============================================================
 * 首页信息流取数 Hook（usePostsFeed）
 * ============================================================
 * 基于 React Query 的 Infinite Query：
 * - staleTime: Infinity —— 等价于原模块级 cachedPosts 的
 *   "切换页面不重载"语义（缓存常驻 queryClient）
 * - 无限滚动：首页底部哨兵触发 fetchNextPage，逐页加载，不再
 *   局限于前 20 条（B1 修复）
 * - 下拉刷新 / 帖子创建后通过 refetch() 主动刷新
 * - 点赞/评论数变化通过 setQueryData 就地更新，避免整页重载
 */

import { useInfiniteQuery } from '@tanstack/react-query';
import type { InfiniteData } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { listPostsByCursor } from '../api/posts';
import type { Post } from '../types';

export const postsFeedKey = ['posts', 'feed'] as const;

/** 信息流单页（游标模式）的缓存形状 */
export interface PostsFeedPage {
  posts: Post[];
  next_cursor: string | null;
  has_more: boolean;
}

/** 信息流 InfiniteQuery 缓存数据类型 */
export type PostsFeedData = InfiniteData<PostsFeedPage>;

/**
 * 信息流所有已加载页的帖子（按页展开，保持服务端顺序，**按 ID 去重**）。
 *
 * 去重是防御性的：游标分页下翻页期间的插入/删除不会移动边界，但
 * “下拉刷新重拉第一页 + 继续加载旧页”的并发窗口仍可能短暂出现同一条
 * （重拉的第一页包含刚发布的帖子，旧游标页不会；去重保证 UI 不重复渲染）。
 */
export function feedPostsFlat(data: PostsFeedData | undefined): Post[] {
  const seen = new Set<number>();
  const out: Post[] = [];
  for (const page of data?.pages ?? []) {
    for (const post of page.posts) {
      if (seen.has(post.id)) continue;
      seen.add(post.id);
      out.push(post);
    }
  }
  return out;
}

/**
 * 就地更新信息流缓存（所有页展开后统一变换，再按每页原始容量回写）。
 * 供点赞/评论/删除等事件同步使用，避免整页重载。
 */
export function updatePostsFeed(queryClient: QueryClient, updater: (posts: Post[]) => Post[]): void {
  queryClient.setQueryData<PostsFeedData>(postsFeedKey, (prev) => {
    if (!prev) return prev;
    const all = updater(feedPostsFlat(prev));
    // 按页原始容量拆回（超出部分并入最后一页，防止删帖后提前触发加载更多）
    let offset = 0;
    const pages = prev.pages.map((p) => {
      const slice = all.slice(offset, offset + p.posts.length);
      offset += p.posts.length;
      return { ...p, posts: slice };
    });
    // 若展开后数组比原来短（删除/去重），把多出来的尾部补到最后一页
    const remaining = all.slice(offset);
    const lastPage = pages.length > 0 ? pages[pages.length - 1] : undefined;
    if (remaining.length > 0 && lastPage) {
      pages[pages.length - 1] = { ...lastPage, posts: [...lastPage.posts, ...remaining] };
    }
    return { ...prev, pages };
  });
}

export function usePostsFeed() {
  return useInfiniteQuery({
    queryKey: postsFeedKey,
    queryFn: ({ pageParam }) => listPostsByCursor(pageParam, 20, { timeout: 10000 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.has_more && last.next_cursor ? last.next_cursor : undefined),
    staleTime: Infinity,
  });
}
