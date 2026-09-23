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
import { isNative } from './lib/native';
import { checkCoreCapabilities } from './lib/compat';
import App from './App';
import UnsupportedEnv from './components/UnsupportedEnv';
import './styles/global.css';

if (isNative()) {
  document.documentElement.classList.add('native-app');
}

// 注：原此处有 JS 注入 backdrop-filter 强制毛玻璃的代码，已移除。
// 实际根因并非 backdrop-filter，而是 Android WebView 上 body 作为滚动容器时，
// position:fixed 子元素在惯性滚动期间会跟随移动；且 100vh 比实际可视区大
// 导致聊天区高度异常。修复方案见 global.css 移动端滚动架构区块。

// 挂载 React 应用到 DOM
//
// ★ 核心能力门槛（2026-09-19）：缺任一核心能力（存储 / fetch / WebSocket / matchMedia）
//   就**只渲染提示页、不加载应用**。不再为这类内核做功能降级兼容 —— 在半残状态下
//   勉强运行（能进页面但处处静默失效），比明确告知"版本过低"更难排查也更难用。
//   注意本文件自身的语法仍需被老内核解析（构建 target 钉在 safari14），否则白屏无提示。
const core = checkCoreCapabilities();
if (!core.ok) {
  console.warn('[K] 核心能力缺失，已拦截渲染：', core.missing.map((m) => m.id).join(', '));
}
//
// onUncaughtError：错误边界（components/ErrorBoundary）只接得住渲染期异常，
// 事件处理器/异步回调里的异常不会走到边界 —— 此前这类错误在 React 19 里
// 只会静默进控制台，线上无人知晓。这里显式记录一条，便于排查。
createRoot(document.getElementById('root')!, {
  onUncaughtError: (error, errorInfo) => {
    console.error('[K] 未捕获的渲染异常', error, errorInfo.componentStack);
  },
}).render(<StrictMode>{core.ok ? <App /> : <UnsupportedEnv missing={core.missing} />}</StrictMode>);
