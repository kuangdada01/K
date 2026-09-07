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

import { lazy } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useEvent } from '../context/EventContext';
import { useAndroidBackButton } from '../hooks/useAndroidBackButton';
import { MainLayout } from '../layouts/MainLayout';
import { ProtectedRoute } from './ProtectedRoute';
import CreatePost from '../components/post/CreatePost';
import EditPost from '../components/post/EditPost';
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

      {/* 全局模态框 */}
      {showLoginPrompt && <LoginPrompt onClose={closeLoginPrompt} />}
      {showCreate && <CreatePost />}
      {editPost && <EditPost />}
    </>
  );
}
