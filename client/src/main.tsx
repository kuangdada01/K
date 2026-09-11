/**
 * ============================================================
 * K 前端入口文件
 * ============================================================
 * React 应用的入口点
 * - 使用 StrictMode 启用严格模式检查
 * - 挂载 App 组件到 DOM #root 元素
 * - 引入全局样式
 * - onUncaughtError：兜底记录「连错误边界都没接住」的异常
 * ============================================================
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Capacitor } from '@capacitor/core';
import App from './App';
import './styles/global.css';

if (Capacitor.isNativePlatform()) {
  document.documentElement.classList.add('native-app');
}

// 注：原此处有 JS 注入 backdrop-filter 强制毛玻璃的代码，已移除。
// 实际根因并非 backdrop-filter，而是 Android WebView 上 body 作为滚动容器时，
// position:fixed 子元素在惯性滚动期间会跟随移动；且 100vh 比实际可视区大
// 导致聊天区高度异常。修复方案见 global.css 移动端滚动架构区块。

// 挂载 React 应用到 DOM
//
// onUncaughtError：错误边界（components/ErrorBoundary）只接得住渲染期异常，
// 事件处理器/异步回调里的异常不会走到边界 —— 此前这类错误在 React 19 里
// 只会静默进控制台，线上无人知晓。这里显式记录一条，便于排查。
createRoot(document.getElementById('root')!, {
  onUncaughtError: (error, errorInfo) => {
    console.error('[K] 未捕获的渲染异常', error, errorInfo.componentStack);
  },
}).render(
  <StrictMode>
    <App />
  </StrictMode>
);
