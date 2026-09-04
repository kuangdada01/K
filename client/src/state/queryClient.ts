/**
 * ============================================================
 * React Query 客户端配置
 * ============================================================
 * 全局唯一 queryClient：
 * - retry: false —— 与历史 axios 行为一致（失败不自动重试）
 * - staleTime 0 —— 保持"每次挂载都取最新"的历史语义
 */

import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
      staleTime: 0,
    },
    mutations: {
      retry: false,
    },
  },
});
