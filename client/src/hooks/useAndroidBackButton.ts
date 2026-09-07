/**
 * ============================================================
 * 安卓硬件返回键 Hook（hooks/useAndroidBackButton）
 * ============================================================
 * 自 App.tsx 拆出（行为不变）：仅 Capacitor 原生平台注册。
 * 返回优先级：全局模态框（登录/编辑/创建）→ 最深 [data-back] 按钮
 * → 搜索/图书单次返回 → 主 Tab 双击退出（2s 内再按最小化）。
 */

import { useEffect, useRef } from 'react';
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { showToast } from '../components/ui/Toast';

interface AndroidBackButtonOptions {
  showLoginPrompt: boolean;
  closeLoginPrompt: () => void;
  editPost: boolean;
  closeEdit: () => void;
  showCreate: boolean;
  closeCreate: () => void;
}

export function useAndroidBackButton({
  showLoginPrompt,
  closeLoginPrompt,
  editPost,
  closeEdit,
  showCreate,
  closeCreate,
}: AndroidBackButtonOptions): void {
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 安卓硬件返回键处理
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    const MAIN_TABS = [
      '/',
      '/explore',
      '/messages',
      '/announcements',
      '/profile',
      '/admin',
      '/books',
      '/voice',
    ];

    // 获取当前真实路径（不用 React state，避免闭包旧值）
    const getPath = () => window.location.hash.replace(/^#/, '') || '/';

    // 查找最深层的 [data-back] 按钮（避免点击外层 PostDetail 的关闭按钮）
    const findDeepestBackBtn = (): HTMLElement | null => {
      const all = document.querySelectorAll('[data-back]');
      return all.length > 0 ? (all[all.length - 1] as HTMLElement) : null;
    };

    const handler = () => {
      // 1. 关闭模态框
      if (showLoginPrompt) {
        closeLoginPrompt();
        return;
      }
      if (editPost) {
        closeEdit();
        return;
      }
      if (showCreate) {
        closeCreate();
        return;
      }

      // 2. 触发最深层的返回图标功能（适用于所有页面）
      const backBtn = findDeepestBackBtn();
      if (backBtn) {
        backBtn.click();
        return;
      }

      // 3. 搜索/图书单次返回（首页右上角/图书入口，需 1 次回退而非双击退出）
      const currentPath = getPath();
      if (
        currentPath === '/explore' ||
        currentPath.startsWith('/explore?') ||
        currentPath.startsWith('/explore#') ||
        currentPath.startsWith('/explore/')
      ) {
        if (window.history.length > 1) window.history.back();
        else {
          window.location.hash = '#/';
        }
        return;
      }
      if (currentPath.startsWith('/books/')) {
        const backBtn = findDeepestBackBtn();
        if (backBtn) {
          backBtn.click();
          return;
        }
        if (window.history.length > 1) window.history.back();
        else {
          window.location.hash = '#/books';
        }
        return;
      }
      if (MAIN_TABS.includes(currentPath)) {
        window.history.pushState(null, '', window.location.href);

        if (exitTimerRef.current) {
          clearTimeout(exitTimerRef.current);
          exitTimerRef.current = null;
          // 最小化到后台（moveTaskToBack）：进程保留，用户从最近任务划掉才真正关闭。
          // exitApp() 会 finishAffinity 直接杀进程，不符合预期
          CapApp.minimizeApp();
        } else {
          showToast('再按一次退出应用');
          exitTimerRef.current = setTimeout(() => {
            exitTimerRef.current = null;
          }, 2000);
        }
      }
    };

    const listener = CapApp.addListener('backButton', handler);
    return () => {
      listener.then((l) => l.remove());
    };
  }, [showLoginPrompt, closeLoginPrompt, showCreate, closeCreate, editPost, closeEdit]);
}
