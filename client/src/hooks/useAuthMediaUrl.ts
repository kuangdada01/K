/**
 * ============================================================
 * 鉴权媒体 URL Hook (useAuthMediaUrl)
 * ============================================================
 * /api/ 开头的媒体（私信图片、私密图片）需要携带 JWT 才能访问，
 * <img> 无法自定义请求头，因此用 axios 拉取 blob 再生成本地 objectURL。
 * 普通资源（静态 /uploads/...、blob:/data:/http 预览）直接同步返回。
 */

import { useEffect, useMemo, useState } from 'react';
import api from '../api/http';
import { resolveMediaUrl } from '../utils';

export function useAuthMediaUrl(url: string | null | undefined): string | null {
  const isAuthUrl = !!url && url.startsWith('/api/');

  // 非鉴权 URL 无需请求，直接解析（blob:/data:/http 原样，站内相对路径转绝对）
  const directUrl = useMemo(() => {
    if (!url || url.startsWith('/api/')) return null;
    if (/^(blob:|data:|https?:)/.test(url)) return url;
    return resolveMediaUrl(url) || url;
  }, [url]);

  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthUrl) return;

    // 去掉 /api 前缀交给 axios（baseURL 已含 /api），以 blob 拉取后生成 objectURL
    let cancelled = false;
    let created: string | null = null;
    api
      .get(url!.replace(/^\/api/, ''), { responseType: 'blob' })
      .then((res) => {
        if (cancelled) return;
        created = URL.createObjectURL(res.data);
        setObjectUrl(created);
      })
      .catch(() => {
        if (!cancelled) setObjectUrl(null);
      });

    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [isAuthUrl, url]);

  return isAuthUrl ? objectUrl : directUrl;
}
