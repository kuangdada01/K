/**
 * ============================================================
 * 后台通知 Hook（hooks/useNativeNotifications）
 * ============================================================
 * 把 SSE 实时事件（私信/评论通知/公告）在 **App 处于后台** 时投递到系统通知栏。
 *
 * 三条设计取舍：
 * 1. **只在自己人不在前台时弹**：前台时页面本来就有 Toast/红点，再弹通知栏是打扰；
 * 2. **只提醒别人发来的**：自己其他端发出的私信回声不弹（见 notificationForSse）；
 * 3. **通知权限只在首次进 App 后请求一次**（5s 后，避开首屏），拒绝后不再反复弹 ——
 *    反复索要权限是差体验，用户想开可以去系统设置。
 *
 * 真·离线推送（App 被杀也能收到）需要 FCM/厂商推送，属独立立项；
 * 本 Hook 覆盖的是"App 在后台但仍连着 SSE"这一段，也是日常最高频的场景。
 * ============================================================
 */

import { useCallback, useEffect } from 'react';
import { useSse } from './useSse';
import { useAuth } from '../context/AuthContext';
import { isNative, notify, requestNotificationPermission } from '../lib/native';
import { notificationForSse } from '../lib/notifications';

/** 是否已经问过通知权限（避免每次启动都弹） */
const ASKED_KEY = 'k_notif_asked';

export function useNativeNotifications(): void {
  const { user } = useAuth();
  const myId = user?.id ?? null;

  // 首次进入（原生 + 已登录）请求一次通知权限
  useEffect(() => {
    if (!isNative() || !myId) return;
    try {
      if (localStorage.getItem(ASKED_KEY) === '1') return;
    } catch {
      return;
    }
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(ASKED_KEY, '1');
      } catch {
        /* 存储不可用：仍然请求，只是下次会再问一遍 */
      }
      void requestNotificationPermission().catch(() => {});
    }, 5000);
    return () => clearTimeout(timer);
  }, [myId]);

  useSse(
    myId,
    useCallback(
      (type, data) => {
        if (!isNative()) return;
        // 前台不打扰：页面自己有提示
        if (typeof document !== 'undefined' && document.visibilityState === 'visible') return;
        const payload = notificationForSse(type, data, myId);
        if (!payload) return;
        void notify(payload).catch(() => {});
      },
      [myId]
    )
  );
}
