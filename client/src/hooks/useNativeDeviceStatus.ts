/**
 * ============================================================
 * 系统状态 Hook（hooks/useNativeDeviceStatus）
 * ============================================================
 * 为什么需要原生这一路：WebView 里的 `navigator.onLine` 在部分机型**恒为 true**
 * （Chromium 只看网卡不看实际连通），断网时页面照样以为自己在线，
 * 上传/发帖失败却报"网络错误"，用户看不出所以然。原生 `ConnectivityManager` 是准的。
 *
 * 这里只做一件用户可见的事：断网/恢复时给一次提示（不弹窗、不阻塞）。
 * 其它系统信息（电量/存储/机型）由 `getDeviceInfo()` 按需拉取，见 `useMediaDraft` 的流量提示。
 * ============================================================
 */

import { useEffect, useRef } from 'react';
import { getDeviceInfo, isNative, onFirstPaint, onNetworkChanged, onRendererGone } from '../lib/native';
import type { NetworkType } from '../lib/native';
import { showToast } from '../components/ui/Toast';

export function useNativeDeviceStatus(): void {
  /** 上一次已知网络类型（null = 还没读到；避免刚启动就误报"已断开"） */
  const lastRef = useRef<NetworkType | null>(null);

  useEffect(() => {
    if (!isNative()) return;

    void getDeviceInfo()
      .then((info) => {
        lastRef.current = info.network;
        // 三期诊断：启动时打一次现场（首帧耗时/崩溃计数/上次退出原因），
        // 排查"App 在后台被清掉""偶发崩溃"时不用再装工具
        console.info(
          `[K] 原生首帧 ${info.lastFirstPaintMs >= 0 ? `${info.lastFirstPaintMs}ms` : '未知'}` +
            ` · 渲染崩溃累计 ${info.rendererCrashes}` +
            ` · 上次退出 ${info.lastExitReason ?? '未知'}`
        );
      })
      .catch(() => {});

    const offNetwork = onNetworkChanged(({ type }) => {
      const previous = lastRef.current;
      lastRef.current = type;
      if (previous === null || previous === type) return;
      if (type === 'none') {
        showToast('网络已断开');
      } else if (previous === 'none') {
        showToast('网络已恢复');
      }
    });

    const offFirstPaint = onFirstPaint(({ ms }) => {
      console.info(`[K] 本次冷启动首帧 ${ms}ms`);
    });

    const offRendererGone = onRendererGone(({ count }) => {
      console.warn(`[K] WebView 渲染进程崩溃（已自动重建），累计 ${count} 次`);
    });

    return () => {
      offNetwork();
      offFirstPaint();
      offRendererGone();
    };
  }, []);
}
