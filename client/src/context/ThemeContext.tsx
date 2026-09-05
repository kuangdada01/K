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
 * - Capacitor Android 状态栏样式适配
 * ============================================================
 */

import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';

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
 * 更新 Android 状态栏图标颜色
 * 双通道保障：Capacitor 插件 + AndroidBridge 兜底
 * 关键：system 模式传 Style.Default，让 Capacitor 插件自主跟随系统变化
 */
function applyStatusBar(mode: ThemeMode) {
  const isNative = Capacitor.isNativePlatform() || !!(window as any).AndroidBridge;
  if (!isNative) return;

  let capacitorStyle = Style.Default;
  if (mode === 'light') capacitorStyle = Style.Light;
  else if (mode === 'dark') capacitorStyle = Style.Dark;

  console.log(`[Theme] applyStatusBar: mode=${mode} capacitorStyle=${capacitorStyle}`);

  StatusBar.setStyle({ style: capacitorStyle }).catch((e) => {
    console.warn('[Theme] Capacitor StatusBar.setStyle failed:', e);
  });

  // 状态栏底色随主题：WebView 非 edge-to-edge（从状态栏下方开始），
  // styles.xml 只能定死一个启动色，运行时明暗切换在这里跟随
  const effective: 'light' | 'dark' =
    mode === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : mode;
  const bgColor = effective === 'dark' ? '#0d0f14' : '#eef2ee';
  StatusBar.setBackgroundColor({ color: bgColor }).catch((e) => {
    console.warn('[Theme] Capacitor StatusBar.setBackgroundColor failed:', e);
  });

  try {
    const bridge = (window as any).AndroidBridge;
    // Android 16 强制 edge-to-edge：上面的 setBackgroundColor 会被系统忽略，
    // 状态栏条透出的是 DecorView 背景色，必须显式设置才能跟随应用内主题
    // （应用内深色是 CSS 级切换，系统 uiMode 不变，values-night 不会激活）
    bridge?.setWindowBackgroundColor?.(bgColor);
    bridge?.setAppThemeMode?.(mode);
  } catch {}
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
    const resolved = resolveTheme(newMode);
    setResolved(resolved);
    updateDataTheme(resolved);
    updateThemeColor(resolved);
    // Android: 双通道同步状态栏图标颜色（Capacitor 插件 + AndroidBridge 兜底）
    applyStatusBar(newMode);
  }, []);

  // 初始化：resolved 与 data-theme 已由 useState 初始化器同步（避免首帧闪烁），
  // 此处仅延迟应用状态栏主题，确保 Capacitor Bridge 已初始化
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

  return <ThemeContext.Provider value={{ mode, resolved, setMode }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
