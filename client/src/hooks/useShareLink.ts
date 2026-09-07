/**
 * ============================================================
 * 分享链接 Hook（useShareLink）
 * ============================================================
 * 自 PostCard / PostDetail 的 handleShare 拆出（纯搬移，行为不变）：
 * - 登录门槛（requireLogin，未登录弹登录提示并短路）
 * - 复制链接（clipboard 优先，HTTP 环境降级 textarea + execCommand）
 * - tooltip 显示 1500ms（setShowTooltip(true) → 1500ms 后 false）
 * - 可选分享计数（PostDetail 用：sharePost 成功后更新
 *   shareCount/alreadyShared；PostCard 无此逻辑，不传即跳过）
 * ============================================================
 */

import { useCallback } from 'react';
import * as postsApi from '../api/posts';

export interface UseShareLinkOptions {
  postId: number;
  /** 登录门槛（useFollowUser().requireLogin；未登录弹登录提示并返回 false） */
  requireLogin: () => boolean;
  setShowTooltip: (visible: boolean) => void;
  // —— 可选分享计数（PostDetail 用；PostCard 不传） ——
  alreadyShared?: boolean;
  setAlreadyShared?: (shared: boolean) => void;
  setShareCount?: (count: number) => void;
}

export function useShareLink({
  postId,
  requireLogin,
  setShowTooltip,
  alreadyShared,
  setAlreadyShared,
  setShareCount,
}: UseShareLinkOptions): () => Promise<void> {
  return useCallback(async () => {
    if (!requireLogin()) return;
    const url = `${window.location.origin}/post/${postId}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // HTTP 环境降级：用 textarea 复制
      const ta = document.createElement('textarea');
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setShowTooltip(true);
    setTimeout(() => setShowTooltip(false), 1500);
    // 分享计数（PostDetail 原逻辑：仅在未分享过时上报；进入此处时已过登录门槛）
    if (alreadyShared === false && setAlreadyShared && setShareCount) {
      try {
        const res = await postsApi.sharePost(postId);
        setShareCount(res.share_count);
        setAlreadyShared(true);
      } catch {}
    }
  }, [postId, requireLogin, setShowTooltip, alreadyShared, setAlreadyShared, setShareCount]);
}
