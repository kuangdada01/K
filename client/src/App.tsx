/**
 * ============================================================
 * K 应用根组件（App）—— Provider 组合 + Router 选择
 * ============================================================
 * 自拆分后仅负责:
 * 1. 路由容器（Web: BrowserRouter, Android: HashRouter）
 * 2. 全局 Context 层级（认证、语音、事件、主题、音乐）
 * 3. 全局 Toast 与 App 更新提示
 *
 * 路由表与全局模态框见 router/AppRoutes.tsx，
 * 主布局见 layouts/MainLayout.tsx，受保护路由守卫见 router/ProtectedRoute.tsx。
 * ============================================================
 */

import { BrowserRouter, HashRouter } from 'react-router-dom';
import { isNative } from './lib/native';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './state/queryClient';
import { AuthProvider } from './context/AuthContext';
import { VoiceProvider } from './context/VoiceContext';
import { ThemeProvider } from './context/ThemeContext';
import { EventProvider } from './context/EventContext';
import { MusicProvider } from './context/MusicContext';
import { AppRoutes } from './router/AppRoutes';
import Toast from './components/ui/Toast';
import AppUpdatePrompt from './components/AppUpdatePrompt';

/** 安卓原生宿主内使用 HashRouter（页面由本地资源域提供，history 路由会在刷新/重建时 404），Web 环境使用 BrowserRouter */
const Router = isNative() ? HashRouter : BrowserRouter;

export default function App() {
  return (
    <Router>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <AuthProvider>
            <VoiceProvider>
              <EventProvider>
                <MusicProvider>
                  <AppRoutes />
                  <Toast />
                  <AppUpdatePrompt />
                </MusicProvider>
              </EventProvider>
            </VoiceProvider>
          </AuthProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </Router>
  );
}
