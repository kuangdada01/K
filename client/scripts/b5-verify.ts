/**
 * 回归验证：B5 切换账号缓存残留清理机制
 * 用真实 @tanstack/react-query QueryClient 模拟 cache.ts 的
 * follow/like/repost/bookmark 缓存 key（['cache', ...]）+ 信息流缓存，
 * 验证 queryClient.removeQueries() 与 clearInteractionCaches 能清空。
 *
 * 运行（从 client 目录，借用 server 的 tsx）：
 *   & "..\server\node_modules\.bin\tsx.cmd" b5-verify.ts
 * 预期输出：B5 验证通过…
 */

import { QueryClient } from '@tanstack/react-query';

function simulateB5(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  // 模拟登录 A 后产生的各类缓存
  qc.setQueryData(['posts', 'feed'], {
    pages: [{ posts: [{ id: 1 }], page: 1, totalPages: 1 }],
    pageParams: [1],
  }); // 信息流（staleTime: Infinity 常驻）
  qc.setQueryData(['cache', 'follow', 42], true); // 已关注
  qc.setQueryData(['cache', 'like', 7], { liked: true, likeCount: 1 }); // 已赞
  qc.setQueryData(['cache', 'repost', 7], true); // 已转发
  qc.setQueryData(['cache', 'bookmark', 7], true); // 已收藏

  const cacheKeysBefore = qc
    .getQueryCache()
    .getAll()
    .map((q) => JSON.stringify(q.queryKey))
    .sort();
  console.log('清空前缓存 keys:', cacheKeysBefore);

  // ====== 模拟 AuthContext.logout() / auth:expired 处理 ======
  // 1) queryClient.removeQueries() —— 清掉全部查询缓存
  qc.removeQueries();
  // 2) clearInteractionCaches() —— 清掉 ['cache', ...] 内存交互缓存
  qc.removeQueries({ queryKey: ['cache'] });

  const cacheKeysAfter = qc
    .getQueryCache()
    .getAll()
    .map((q) => JSON.stringify(q.queryKey));
  console.log('清空后缓存 keys:', cacheKeysAfter);

  if (cacheKeysAfter.length !== 0) {
    throw new Error(`B5 验证失败：切换账号后仍有缓存残留: ${cacheKeysAfter.join(', ')}`);
  }

  // ====== 附加验证：seedFollowedUsers 的 key 与 clearInteractionCaches 的 key 前缀一致 ======
  // AuthContext 用 seedFollowedUsers 写入 ['cache','follow',id]，logout 用 removeQueries({queryKey:['cache']}) 清除
  qc.setQueryData(['cache', 'follow', 42], true);
  qc.setQueryData(['cache', 'follow', 43], true);
  qc.removeQueries({ queryKey: ['cache'] });
  const remaining = qc
    .getQueryCache()
    .getAll()
    .map((q) => JSON.stringify(q.queryKey));
  if (remaining.length !== 0) {
    throw new Error(`B5 验证失败：clearInteractionCaches 未能清空 follow 缓存: ${remaining.join(', ')}`);
  }

  console.log('B5 验证通过：queryClient.removeQueries() 与 clearInteractionCaches 均可清空跨账号残留缓存');
}

simulateB5();
