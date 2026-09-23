/**
 * ============================================================
 * 主题上下文 (ThemeContext)
 * ============================================================
 * 管理应用的亮色/暗色主题切换
 *
 * 功能:
 * - 三种模式: 'light' | 'dark' | 'system'(默认跟随系统)
 * - localStorage 持久化用户选择
 * - 在 <html> 上设置 data-theme 属性驱动 CSS 变量
 * - 监听系统 prefers-color-scheme 变化（system 模式下自动切换）
 * - 动态更新 <meta name="theme-color">
 * - 原生宿主：同步状态栏图标颜色与窗口背景色（经 lib/native 桥）
 * ============================================================
 */

import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { isNative, setStatusBarBackground, setStatusBarStyle, setWindowBackgroundColor } from '../lib/native';

type ThemeMode = 'light' | 'dark' | 'system';

interface ThemeContextValue {
  /** 用户选择的主题模式 */
  mode: ThemeMode;
  /** 实际生效的主题（resolved） */
  resolved: 'light' | 'dark';
  /** 切换主题模式 */
  setMode: (mode: ThemeMode) => void;
}

const STORAGE_KEY = 'theme';

const ThemeContext = createContext<ThemeContextValue>({
  mode: 'system',
  resolved: 'light',
  setMode: () => {},
});

/** 读取系统主题偏好 */
function getSystemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** 根据 mode 计算实际生效主题 */
function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  return mode === 'system' ? getSystemTheme() : mode;
}

/** 更新 <meta name="theme-color"> */
function updateThemeColor(theme: 'light' | 'dark') {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute('content', theme === 'dark' ? '#0d0f14' : '#eef2ee');
  }
}

/** 更新 <html> 的 data-theme 属性 */
function updateDataTheme(theme: 'light' | 'dark') {
  document.documentElement.setAttribute('data-theme', theme);
}

/**
 * 同步原生宿主的系统栏与窗口背景。
 *
 * 三件事缺一不可：
 * 1. `statusBar.setStyle`：状态栏图标明暗（system 传 system，由原生读系统 uiMode）；
 * 2. `statusBar.setBackground`：非 edge-to-edge 机型/Android 16 之前的状态栏底色；
 * 3. `window.setBackgroundColor`：**edge-to-edge 下状态栏区域透出的就是这一层**，
 *    应用内深色是 CSS 级切换（系统 uiMode 不变、values-night 不会激活），
 *    不显式设置就会露白（浅色→深色时）或露黑（深色→浅色时）。
 */
function applyStatusBar(mode: ThemeMode) {
  if (!isNative()) return;

  setStatusBarStyle(mode);

  const effective: 'light' | 'dark' = mode === 'system' ? getSystemTheme() : mode;
  const bgColor = effective === 'dark' ? '#0d0f14' : '#eef2ee';
  setStatusBarBackground(bgColor);
  setWindowBackgroundColor(bgColor);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
    return 'system';
  });

  const [resolved, setResolved] = useState<'light' | 'dark'>(() => {
    const theme = resolveTheme(mode);
    // 同步设置 data-theme，避免首次渲染闪烁
    updateDataTheme(theme);
    updateThemeColor(theme);
    return theme;
  });

  /** 设置主题模式并持久化 */
  const setMode = useCallback((newMode: ThemeMode) => {
    setModeState(newMode);
    localStorage.setItem(STORAGE_KEY, newMode);
    const resolvedTheme = resolveTheme(newMode);
    setResolved(resolvedTheme);
    updateDataTheme(resolvedTheme);
    updateThemeColor(resolvedTheme);
    // 原生宿主：同步状态栏图标颜色与窗口背景色
    applyStatusBar(newMode);
  }, []);

  // 初始化：resolved 与 data-theme 已由 useState 初始化器同步（避免首帧闪烁），
  // 此处仅延迟应用状态栏主题，确保原生 WebView 与桥已就绪
  useEffect(() => {
    const timer = setTimeout(() => {
      applyStatusBar(mode);
    }, 600);

    return () => clearTimeout(timer);
  }, [mode]);

  // 监听系统主题变化（仅 system 模式下响应）
  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      if (mode === 'system') {
        const theme = getSystemTheme();
        setResolved(theme);
        updateDataTheme(theme);
        updateThemeColor(theme);
        applyStatusBar('system');
      }
    };
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [mode]);

  // value 必须 memo：对象字面量每次渲染都是新引用，会让 useTheme() 消费者
  // 在 provider 因任何原因重渲染时跟着重渲染（同仓库 EventContext 已是此写法）
  const value = useMemo(() => ({ mode, resolved, setMode }), [mode, resolved, setMode]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
