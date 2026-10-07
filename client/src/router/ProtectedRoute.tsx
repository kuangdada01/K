/**
 * ============================================================
 * 受保护路由守卫（router/ProtectedRoute）
 * ============================================================
 * 纯认证守卫：未登录重定向首页（登录统一走 LoginPrompt 弹窗）。
 */

import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export function ProtectedRoute() {
  const { user, loading } = useAuth();

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

  if (!user) {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}
