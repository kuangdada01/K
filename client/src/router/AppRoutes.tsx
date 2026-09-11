/**
 * ============================================================
 * 应用路由配置（router/AppRoutes）
 * ============================================================
 * 自 App.tsx 拆出（行为不变）：
 * - 路由表：MainLayout 内公开/受保护路由 + 404 兜底
 * - 全局模态框：LoginPrompt / CreatePost / EditPost
 * - 安卓硬件返回键（useAndroidBackButton）
 * - 非首屏页面懒加载（与拆分前一致；Suspense 由 MainLayout 提供）
 */

import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useEvent } from '../context/EventContext';
import { useAndroidBackButton } from '../hooks/useAndroidBackButton';
import { MainLayout } from '../layouts/MainLayout';
import { ProtectedRoute } from './ProtectedRoute';
import { loadCreatePost, loadEditPost } from './composerChunks';
import ErrorBoundary from '../components/ErrorBoundary';
import LoginPrompt from '../components/LoginPrompt';
import HomePage from '../pages/HomePage';

// 懒加载非首屏页面
const ExplorePage = lazy(() => import('../pages/ExplorePage'));
const MessagesPage = lazy(() => import('../pages/MessagesPage'));
const ProfilePage = lazy(() => import('../pages/ProfilePage'));
const AdminPage = lazy(() => import('../pages/admin/AdminPage'));
const AnnouncementPage = lazy(() => import('../pages/AnnouncementPage'));
const BooksPage = lazy(() => import('../pages/BooksPage'));
const BookDetailPage = lazy(() => import('../pages/BookDetailPage'));
const BookReaderPage = lazy(() => import('../pages/BookReaderPage'));
const VoicePage = lazy(() => import('../pages/VoicePage'));

// 发布/编辑弹层同样懒加载（P1-7）：它们是首屏里最大的一块「大多数会话用不到」的代码。
// 入口按钮会在 hover/focus 时预取（见 composerChunks），所以正常点开没有额外等待。
const CreatePost = lazy(loadCreatePost);
const EditPost = lazy(loadEditPost);

/** 弹层崩溃时的兜底：居中提示 + 「关闭」把用户放回页面（而不是白屏 + 丢内容） */
function ComposerCrashFallback({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'grid', placeItems: 'center', zIndex: 1000 }}>
      <div style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
        <div>{title}</div>
        <button
          type="button"
          onClick={onClose}
          style={{
            marginTop: 12,
            padding: '6px 16px',
            borderRadius: 8,
            border: '1px solid var(--border-color, rgba(128,128,128,0.35))',
            background: 'transparent',
            color: 'inherit',
            cursor: 'pointer',
            fontSize: 13,
          }}
        >
          关闭
        </button>
      </div>
    </div>
  );
}

export function AppRoutes() {
  const { loading, showLoginPrompt, closeLoginPrompt } = useAuth();
  const { showCreate, closeCreate, editPost, closeEdit } = useEvent();

  useAndroidBackButton({
    showLoginPrompt,
    closeLoginPrompt,
    editPost: editPost !== null,
    closeEdit,
    showCreate,
    closeCreate,
  });

  if (loading) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          color: 'var(--text-secondary)',
        }}
      >
        加载中...
      </div>
    );
  }

  return (
    <>
      {/* 路由表 */}
      <Routes>
        {/* MainLayout: 侧边栏始终可见 */}
        <Route element={<MainLayout />}>
          {/* 公开路由（无需登录即可浏览） */}
          <Route path="/" element={<HomePage />} />
          <Route path="/post/:id" element={<HomePage />} />
          <Route path="/explore" element={<ExplorePage />} />
          <Route path="/books" element={<BooksPage />} />
          <Route path="/books/:id" element={<BookDetailPage />} />
          <Route path="/books/:id/read" element={<BookReaderPage />} />
          <Route path="/voice" element={<VoicePage />} />

          {/* 受保护路由（需登录） */}
          <Route element={<ProtectedRoute />}>
            <Route path="/messages" element={<MessagesPage />} />
            <Route path="/messages/:userId" element={<MessagesPage />} />
            <Route path="/profile" element={<ProfilePage />} />
            <Route path="/profile/:id" element={<ProfilePage />} />
            <Route path="/admin" element={<AdminPage />} />
            <Route path="/announcements" element={<AnnouncementPage />} />
          </Route>
        </Route>

        {/* 404 兜底: 重定向到首页 */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>

      {/* 全局模态框（懒加载：fallback 用 null —— 弹层加载期间不显示任何占位，
          避免「点开先闪一下 loading」。入口的 hover 预取让这条路径平时不会等待） */}
      <Suspense fallback={null}>
        {showLoginPrompt && <LoginPrompt onClose={closeLoginPrompt} />}
        {/* 弹层各包一层错误边界：发布会话里崩一次不该把整页带走 */}
        {showCreate && (
          <ErrorBoundary
            label="CreatePost"
            fallback={({ reset }) => (
              <ComposerCrashFallback
                title="发布功能出错了"
                onClose={() => {
                  reset();
                  closeCreate();
                }}
              />
            )}
          >
            <CreatePost />
          </ErrorBoundary>
        )}
        {editPost && (
          <ErrorBoundary
            label="EditPost"
            fallback={({ reset }) => (
              <ComposerCrashFallback
                title="编辑功能出错了"
                onClose={() => {
                  reset();
                  closeEdit();
                }}
              />
            )}
          >
            <EditPost />
          </ErrorBoundary>
        )}
      </Suspense>
    </>
  );
}
