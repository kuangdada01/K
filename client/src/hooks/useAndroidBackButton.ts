/**
 * ============================================================
 * 安卓硬件返回键 Hook（hooks/useAndroidBackButton）
 * ============================================================
 * 自 App.tsx 拆出（行为不变）：仅原生宿主内注册。
 * 返回优先级：全局模态框（登录/编辑/创建）→ 最深 [data-back] 按钮
 * → 搜索/图书单次返回 → 主 Tab 双击退出（2s 内再按最小化到后台）。
 *
 * 与旧实现（Capacitor App 插件事件）的差异：
 * 原生侧用 `OnBackPressedCallback` 同步调用 `window.__KNative.onBackPressed()`，
 * 取本函数的**返回值**作为裁决 —— 不再有"事件发出去、原生自己决定"的时序问题：
 *   'handled'  网页已处理（关闭模态/点了返回按钮）
 *   'minimize' 原生最小化到后台（moveTaskToBack，进程保留）
 *   'exit'     原生结束 Activity
 * 原生侧另有一条 300ms 超时兜底（桥未就绪时不杀进程，改为最小化）。
 * ============================================================
 */

import { useEffect, useRef } from 'react';
import { isNative, setBackDecisionHandler } from '../lib/native';
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

  useEffect(() => {
    if (!isNative()) return;

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

    const handler = (): string => {
      // 1. 关闭模态框
      if (showLoginPrompt) {
        closeLoginPrompt();
        return 'handled';
      }
      if (editPost) {
        closeEdit();
        return 'handled';
      }
      if (showCreate) {
        closeCreate();
        return 'handled';
      }

      // 2. 触发最深层的返回图标功能（适用于所有页面）
      const backBtn = findDeepestBackBtn();
      if (backBtn) {
        backBtn.click();
        return 'handled';
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
        else window.location.hash = '#/';
        return 'handled';
      }
      if (currentPath.startsWith('/books/')) {
        if (window.history.length > 1) window.history.back();
        else window.location.hash = '#/books';
        return 'handled';
      }

      // 4. 主 Tab：两秒内再按一次 → 最小化到后台（进程保留，用户从最近任务划掉才真正关闭）
      if (MAIN_TABS.includes(currentPath)) {
        window.history.pushState(null, '', window.location.href);

        if (exitTimerRef.current) {
          clearTimeout(exitTimerRef.current);
          exitTimerRef.current = null;
          return 'minimize';
        }
        showToast('再按一次退出应用');
        exitTimerRef.current = setTimeout(() => {
          exitTimerRef.current = null;
        }, 2000);
        return 'handled';
      }

      // 未覆盖的路径（深链等）：最小化而不是杀进程（与"双击返回=最小化"的既定语义一致）
      return 'minimize';
    };

    setBackDecisionHandler(handler);
    return () => {
      setBackDecisionHandler(() => 'minimize');
      if (exitTimerRef.current) {
        clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
    };
  }, [showLoginPrompt, closeLoginPrompt, showCreate, closeCreate, editPost, closeEdit]);
}
