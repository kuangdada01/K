/**
 * ============================================================
 * 分享链接 Hook（useShareLink）
 * ============================================================
 * 自 PostCard / PostDetail 的 handleShare 拆出（纯搬移，行为不变）：
 * - 登录门槛（requireLogin，未登录弹登录提示并短路）
 * - 复制链接（clipboard 优先，HTTP 环境降级 textarea + execCommand）
 * - 原生宿主内**额外**拉起系统分享面板（二期 W1；复制行为保留）
 * - tooltip 显示 1500ms（setShowTooltip(true) → 1500ms 后 false）
 * - 可选分享计数（PostDetail 用：sharePost 成功后更新
 *   shareCount/alreadyShared；PostCard 无此逻辑，不传即跳过）
 * ============================================================
 */

import { useCallback } from 'react';
import * as postsApi from '../api/posts';
import { getServerUrl } from '../config';
import { isNative, shareText } from '../lib/native';

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
    // 分享链接必须指向**服务器**：原生宿主的页面来源是本地资源域
    // （https://appassets.androidplatform.net），用 window.location.origin 拼出来的是死链。
    // 浏览器端 getServerUrl() 为空 → 回落到同源，行为不变。
    const url = `${getServerUrl() || window.location.origin}/post/${postId}`;
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
    // 原生宿主：复制之外再拉起系统分享面板（微信/QQ/复制…）；
    // 不替代复制 —— 分享面板被划掉时用户手里仍然有链接（tooltip 文案也保持一致）
    if (isNative()) {
      void shareText(url, 'K').catch(() => {});
    }
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
