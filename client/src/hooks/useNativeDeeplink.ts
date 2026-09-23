/**
 * ============================================================
 * 深链 Hook（hooks/useNativeDeeplink）
 * ============================================================
 * 处理原生侧经桥送来的 `deeplink` 事件，三类来源：
 * - `link`：站内链接被系统路由到 App，或用户点了本地通知 → 直接路由；
 * - `text`：「分享到 K」的文本 → 是本站链接就路由，否则复制并提示
 *   （把分享内容自动灌进发帖框属后续波次，别在这里做半成品）；
 * - `image`：「分享到 K」的图片 → 当前只提示（落地为发帖需走原生选取+上传，后续波次）。
 *
 * 挂在路由内（AppRoutes），这样 `useNavigate` 才有效。
 * ============================================================
 */

import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { getServerUrl } from '../config';
import { isNative, notifyWebReady, onDeeplink } from '../lib/native';
import { normalizeDeeplinkPath, parseSharedText } from '../lib/notifications';
import { showToast } from '../components/ui/Toast';

export function useNativeDeeplink(): void {
  const navigate = useNavigate();
  /** 同一次意图可能被重复投递（首帧补发 + onNewIntent），去重 */
  const lastHandledRef = useRef<string>('');
  /**
   * 用 ref 持有 navigate：**不能**直接把 `navigate` 放进 effect 依赖 ——
   * react-router 的 `useNavigate` 身份会随 location 变化（v6.3+ 为了支持相对导航把
   * pathname 放进了它的 deps），于是每切一次 tab 这个 effect 就会重跑一次：
   * 退订/重订 + 再握手一次（真机日志里能看到每次切页都打一行"网页侧握手完成"），
   * 而宿主那边会把 `lastDeeplink` 再补发一次 —— 用户每切一次 tab 就被弹回上次那个帖子。
   * 订阅与握手都只该在**文档加载时做一次**。
   */
  const navigateRef = useRef(navigate);
  // 在 effect 里更新（渲染期写 ref 会被 react-hooks 规则拦下）。声明顺序在前，
  // 挂载/更新时都先于下面的订阅 effect 执行，所以事件回调读到的永远是最新的 navigate。
  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);

  useEffect(() => {
    if (!isNative()) return;

    const off = onDeeplink((payload) => {
      const go = (path: string) => {
        if (path === lastHandledRef.current) return;
        lastHandledRef.current = path;
        navigateRef.current(path);
      };

      if (payload.kind === 'link') {
        go(normalizeDeeplinkPath(payload.path));
        return;
      }

      if (payload.kind === 'text') {
        const text = payload.text ?? '';
        const path = parseSharedText(text, getServerUrl());
        if (path) {
          go(path);
          return;
        }
        void navigator.clipboard?.writeText(text).catch(() => {});
        showToast('分享内容已复制，可粘贴到发帖框');
        return;
      }

      if (payload.kind === 'image') {
        showToast('已收到图片分享（在 App 内直接发帖将在后续版本支持）');
      }
    });

    // 订阅器已就位 → 告诉原生可以补发冷启动深链了。
    // 必须在**订阅之后**调用：原生在"首个内容可见"就补发的话，那时 React 还没挂载，
    // 事件发出去没人接（用户看到"点了通知打开 App 却没跳转"）。
    notifyWebReady();

    return off;
  }, []);
}
