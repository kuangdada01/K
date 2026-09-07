/**
 * ============================================================
 * 主布局（layouts/MainLayout）
 * ============================================================
 * 始终渲染侧边栏 + 主内容区；不做认证检查（公开与受保护路由共用）。
 * 移动端底部胶囊导航在二级/三级沉浸页（图书详情/阅读器、语音房间内）隐藏。
 */

import { Suspense } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import MusicPlayer from '../components/MusicPlayer';
import { useVoiceInRoom } from '../context/VoiceContext';

function PageLoading() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        color: 'var(--text-secondary)',
        fontSize: 14,
      }}
    >
      加载中...
    </div>
  );
}

/**
 * 移动端底部胶囊导航（Sidebar 在窄屏下的形态）的隐藏判定
 *
 * 桌面端侧边栏始终可见，这里只影响 ≤768px 的底部胶囊导航：
 * 二级/三级页面需要全屏沉浸，底部导航让位（同时回收 .main-content
 * 为胶囊预留的 96px 底部内边距，见 global.css）。
 *
 * 判定来源有两类：
 * 1. 路径匹配 —— 图书详情 /books/:id、阅读器 /books/:id/read
 * 2. 组件状态 —— 语音房间内（/voice 的进房视图，非独立路由）
 */
const HIDE_MOBILE_NAV_PATHS: RegExp[] = [
  /^\/books\/[^/]+/, // 图书详情 + 阅读器（二级/三级页）
];

function useHideMobileNav(): boolean {
  const { pathname } = useLocation();
  const inRoom = useVoiceInRoom();

  if (HIDE_MOBILE_NAV_PATHS.some((re) => re.test(pathname))) return true;
  // 语音房间内：进房视图覆盖整个 /voice 页面，底部导航会让位给控制栏
  if (pathname.startsWith('/voice') && inRoom) return true;
  return false;
}

export function MainLayout() {
  const location = useLocation();
  const isHome = location.pathname === '/';
  // 消息页为聊天类布局：会话列表紧贴侧边栏分隔线（去掉容器间距）
  const isMessages = location.pathname.startsWith('/messages');
  // 二级/三级沉浸页：隐藏移动端底部导航
  const hideMobileNav = useHideMobileNav();

  return (
    <div
      className={[
        'app-layout',
        isMessages ? 'app-layout-messages' : '',
        hideMobileNav ? 'mobile-nav-hidden' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <Sidebar />
      <main className="main-content">
        <Suspense fallback={<PageLoading />}>
          <Outlet />
        </Suspense>
      </main>
      {isHome && <MusicPlayer />}
    </div>
  );
}
