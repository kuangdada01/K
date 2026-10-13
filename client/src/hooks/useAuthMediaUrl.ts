/**
 * ============================================================
 * 鉴权媒体 URL Hook (useAuthMediaUrl)
 * ============================================================
 * /api/ 开头的媒体（私信图片、私密图片）需要携带 JWT 才能访问，
 * <img> 无法自定义请求头，因此用 axios 拉取 blob 再生成本地 objectURL。
 * 普通资源（静态 /uploads/...、blob:/data:/http 预览）直接同步返回。
 *
 * ## 共享 blob 缓存（2026-10-11）
 *
 * 此前每个挂载实例各自请求一次、unmount 即 revoke —— 私信会话 A→B→A
 * 切换时 A 的所有图片重复下载（会话图片多时流量浪费明显）。现在以
 * 「url → objectURL」做模块级共享缓存 + 引用计数：同一 url 只拉一次，
 * 最后一个使用方卸载才 revoke。
 *
 * 计数模型（引用计数最容易错的就是"请求完成前卸载"的竞态）：
 *  · **已缓存**：acquire 同步 +1，release 同步 -1，减到 0 当场 revoke；
 *  · **在途**：acquire 预登记 +1（记入 pendingRefs，不依赖请求何时完成），
 *    release 对在途做 -1；请求完成时把预登记数转正 —— 若此刻已无人使用
 *    （refs ≤ 0）当场 revoke，不留"计数悬空 1"的永久泄漏。
 */

import { useEffect, useMemo, useState } from 'react';
import api from '../api/http';
import { resolveMediaUrl } from '../utils';

// ---- 模块级共享缓存（url → objectURL + 引用计数 + 在途请求单飞） ----

interface CacheEntry {
  objectUrl: string;
  refCount: number;
}

const blobCache = new Map<string, CacheEntry>();
/** 在途请求（同一 url 并发挂载只发一次请求，完成者共享结果） */
const inflight = new Map<string, Promise<string>>();
/** 在途请求的预登记引用数（完成时转正进 CacheEntry，见模块注释） */
const pendingRefs = new Map<string, number>();

function acquireBlob(url: string): Promise<string> {
  const cached = blobCache.get(url);
  if (cached) {
    cached.refCount += 1;
    return Promise.resolve(cached.objectUrl);
  }
  pendingRefs.set(url, (pendingRefs.get(url) ?? 0) + 1);
  let pending = inflight.get(url);
  if (!pending) {
    pending = api
      .get(url.replace(/^\/api/, ''), { responseType: 'blob' })
      .then((res) => {
        inflight.delete(url);
        const objectUrl = URL.createObjectURL(res.data);
        const refs = pendingRefs.get(url) ?? 0;
        pendingRefs.delete(url);
        if (refs <= 0) {
          // 最后一个使用方在请求完成前就卸载了：当场回收，不进缓存
          URL.revokeObjectURL(objectUrl);
        } else {
          blobCache.set(url, { objectUrl, refCount: refs });
        }
        return objectUrl;
      })
      .catch((err) => {
        inflight.delete(url);
        pendingRefs.delete(url);
        throw err;
      });
    inflight.set(url, pending);
  }
  return pending;
}

function releaseBlob(url: string): void {
  const entry = blobCache.get(url);
  if (entry) {
    entry.refCount -= 1;
    if (entry.refCount <= 0) {
      URL.revokeObjectURL(entry.objectUrl);
      blobCache.delete(url);
    }
    return;
  }
  // 在途请求的预登记撤销（请求完成时 refs ≤ 0 走"当场回收"分支）
  const refs = pendingRefs.get(url);
  if (refs !== undefined) {
    if (refs <= 1) pendingRefs.delete(url);
    else pendingRefs.set(url, refs - 1);
  }
}

export function useAuthMediaUrl(url: string | null | undefined): string | null {
  const isAuthUrl = !!url && url.startsWith('/api/');

  // 非鉴权 URL 无需请求，直接解析（blob:/data:/http 原样，站内相对路径转绝对）
  const directUrl = useMemo(() => {
    if (!url || url.startsWith('/api/')) return null;
    if (/^(blob:|data:|https?:)/.test(url)) return url;
    return resolveMediaUrl(url) || url;
  }, [url]);

  const [objectUrl, setObjectUrl] = useState<string | null>(
    // 命中缓存时同步给初值：挂载第一帧就有图，不闪空
    isAuthUrl && url ? (blobCache.get(url)?.objectUrl ?? null) : null
  );

  useEffect(() => {
    if (!isAuthUrl || !url) return;
    let cancelled = false;
    acquireBlob(url)
      .then((u) => {
        if (!cancelled) setObjectUrl(u);
      })
      .catch(() => {
        if (!cancelled) setObjectUrl(null);
      });
    return () => {
      cancelled = true;
      releaseBlob(url);
    };
  }, [isAuthUrl, url]);

  return isAuthUrl ? objectUrl : directUrl;
}
