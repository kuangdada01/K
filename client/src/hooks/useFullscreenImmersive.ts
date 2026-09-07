/**
 * ============================================================
 * 舞台全屏 + 原生沉浸模式 Hook（hooks/useFullscreenImmersive）
 * ============================================================
 * 自 VoiceShareStage.tsx 拆出（§3.4，行为逐行不变）：
 * - 全屏意图（requestFullscreen({navigationUI:'hide'}) 成功回调驱动；
 *   Android WebView custom view 路径的 fullscreenElement 不可靠）
 * - fullscreenchange 兜底：null 事件只有"曾进入真实全屏"才视为退出恢复
 *   （返回手势/系统退出后状态栏恢复的根因修复）
 * - 原生沉浸模式（AndroidBridge.setImmersiveMode）+ 全屏时刷新 theme-color
 *   （部分移动浏览器全屏后状态栏变黑的修复）
 * - 卸载兜底：全屏中离开房间/共享结束 → 恢复系统栏，避免沉浸状态残留
 * ============================================================
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

export function useFullscreenImmersive(stageRef: RefObject<HTMLDivElement | null>) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  /** 全屏意图：requestFullscreen 成功回调即置位。Android WebView 的 div 全屏可能
      走 custom view 路径导致 document.fullscreenElement 为 null，不能据此判断进入，
      原生沉浸模式（隐藏状态栏）必须由主动调用驱动，而非 fullscreenElement 对比。 */
  const fullscreenIntentRef = useRef(false);
  /** 是否曾观察到 document.fullscreenElement 非 null（进入过真实全屏）。
      fullscreenchange 的 null 事件只有"曾见过真实全屏元素"时才视为退出（含返回手势/
      系统退出）；custom view 路径全程 null 时的 null 事件是进入伪事件，不能触发恢复。 */
  const seenFsElementRef = useRef(false);

  // 全屏时刷新 theme-color：部分移动浏览器（微信 X5/QQ 内核等）进入全屏后系统
  // 状态栏变黑（忽略初始 theme-color），强制替换 meta 元素触发浏览器重新读取，
  // 让状态栏恢复页面主题色（浅色 #eef2ee 或深色 #0d0f14）
  const refreshThemeColor = useCallback(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta && meta.parentNode) {
      const color = meta.getAttribute('content') || '#eef2ee';
      const fresh = document.createElement('meta');
      fresh.name = 'theme-color';
      fresh.content = color;
      meta.parentNode.replaceChild(fresh, meta);
    }
  }, []);

  // 原生沉浸模式（隐藏/恢复状态栏+导航栏）；仅原生端存在 AndroidBridge
  const applyImmersive = useCallback(
    (on: boolean) => {
      const bridge = (window as unknown as { AndroidBridge?: { setImmersiveMode?: (v: boolean) => void } })
        .AndroidBridge;
      bridge?.setImmersiveMode?.(on);
      if (on) refreshThemeColor();
    },
    [refreshThemeColor]
  );

  // 全屏状态兜底：进入由 requestFullscreen().then 主动驱动；此监听负责——
  // 正常路径 fullscreenchange（幂等更新 UI）、以及退出恢复（按钮/返回手势/系统退出）。
  // 核心：null 事件只有在"曾进入真实全屏"时才恢复沉浸，避免 custom view 进入伪事件
  // 误触发恢复、也避免返回手势退出后永远保持沉浸（"退出后状态栏黑"的根因）。
  useEffect(() => {
    const sync = () => {
      const inFs = !!document.fullscreenElement;
      if (inFs) {
        seenFsElementRef.current = true;
        setIsFullscreen(true);
        // 必须主动通知原生隐藏系统栏：v0.2.8 漏了此调用，导致 promise reject
        // / WebView 行为差异时状态栏一直显示且被深色化背景覆盖成"黑底+图标"
        applyImmersive(true);
        return;
      }
      if (seenFsElementRef.current) {
        // 曾进入真实全屏，现在 null = 真实退出 → 恢复系统栏
        seenFsElementRef.current = false;
        fullscreenIntentRef.current = false;
        setIsFullscreen(false);
        applyImmersive(false);
        return;
      }
      if (fullscreenIntentRef.current) {
        // 从未见过真实全屏元素但意图全屏中：custom view 进入伪事件，保持沉浸与全屏 UI
        setIsFullscreen(true);
        return;
      }
      setIsFullscreen(false);
      applyImmersive(false);
    };
    document.addEventListener('fullscreenchange', sync);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      // 全屏中离开房间/共享结束导致组件卸载：确保恢复系统栏，避免沉浸状态残留
      if (fullscreenIntentRef.current || seenFsElementRef.current) {
        fullscreenIntentRef.current = false;
        seenFsElementRef.current = false;
        applyImmersive(false);
      }
    };
  }, [applyImmersive]);

  const toggleFullscreen = useCallback(() => {
    const el = stageRef.current;
    if (!el) return;
    // 退出：主动意图清空 + 恢复系统栏（不依赖 fullscreenchange 时序）
    if (document.fullscreenElement || fullscreenIntentRef.current) {
      fullscreenIntentRef.current = false;
      document.exitFullscreen().catch(() => {
        /* 已退出 */
      });
      setIsFullscreen(false);
      applyImmersive(false);
      return;
    }
    const webkitEl = el as HTMLDivElement & { webkitRequestFullscreen?: () => void };
    // navigationUI: "hide" 让浏览器完全隐藏导航 UI（地址栏 + 状态栏），实现真正的
    // 沉浸式全屏——否则默认 "auto" 下 Android Chrome 会残留状态栏位置（"状态栏图标
    // 隐藏了但位置变黑"的根因）；app 端对应 MainActivity 的 hide(systemBars())。
    const doFs = () =>
      el.requestFullscreen
        ? el.requestFullscreen({ navigationUI: 'hide' } as FullscreenOptions)
        : webkitEl.webkitRequestFullscreen?.();
    const p = doFs();
    // 进入全屏成功后主动隐藏系统栏（Android WebView 的 fullscreenElement 判断不可靠，
    // 必须用成功回调驱动原生沉浸模式）
    if (p && typeof (p as Promise<void>).then === 'function') {
      (p as Promise<void>)
        .then(() => {
          fullscreenIntentRef.current = true;
          setIsFullscreen(true);
          applyImmersive(true);
        })
        .catch(() => {
          /* 拒绝则忽略 */
        });
    } else {
      // 老 WebView 的 webkitRequestFullscreen 无 Promise：标记意图，靠 fullscreenchange 兜底
      fullscreenIntentRef.current = true;
      applyImmersive(true);
    }
  }, [stageRef, applyImmersive]);

  return { isFullscreen, toggleFullscreen };
}
