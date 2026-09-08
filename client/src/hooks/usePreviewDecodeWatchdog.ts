/**
 * ============================================================
 * 解码看门狗 Hook（hooks/usePreviewDecodeWatchdog）
 * ============================================================
 * 发布界面视频预览配套：部分浏览器（Edge Android 等）对超出硬件解码
 * 能力的高规格 H.264（4K/level 5.x）表现为「容器解析成功（metadata、
 * videoWidth 正常）但解码器初始化挂起」——不触发 onError、也不触发
 * canplay，黑屏无事件，现有失败检测全部落空，自动恢复链路随之失效。
 *
 * 此 hook 在 video 元素每次挂载（src/key 变化）后启动看门狗：timeoutMs
 * 内若调用方未通过返回的 clear() 确认（canplay / onError 已处理）——
 * 即解码既未成功也未报错——则调用 onTimeout() 判定失败，回到状态轮询
 * 等待（服务端转码完成后重载即恢复）。
 *
 * 边界：arm=false（无 src 或失败面板态）不启动；卸载/重复 arm 自动清理。
 * ============================================================
 */

import { useEffect, useRef } from 'react';

export interface UsePreviewDecodeWatchdogOptions {
  /** 是否武装看门狗（video 元素挂载中且未处于失败态） */
  arm: boolean;
  /** 超时判定失败（调用方置 videoError=true 进入轮询） */
  onTimeout: () => void;
  /** 超时毫秒（默认 6000；覆盖慢网下 canplay 的正常延迟） */
  timeoutMs?: number;
  /**
   * 重启键：video 元素每次重挂载（React key 变化）时传入不同值，
   * 强制重启超时窗口（arm 布尔值可能不变，如同一 URL 的重试）
   */
  restartKey?: unknown;
}

/**
 * @returns clear —— 解码确认（canplay）或错误已处理时调用，解除看门狗
 */
export function usePreviewDecodeWatchdog({
  arm,
  onTimeout,
  timeoutMs = 6000,
  restartKey,
}: UsePreviewDecodeWatchdogOptions): () => void {
  const timerRef = useRef<number | null>(null);
  // 回调每次渲染后更新：定时器触发时始终调用最新实现
  const cbRef = useRef(onTimeout);
  useEffect(() => {
    cbRef.current = onTimeout;
  });

  const clear = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => {
    if (!arm) {
      clear();
      return;
    }
    clear();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      cbRef.current();
    }, timeoutMs);
    return clear;
  }, [arm, timeoutMs, restartKey]);

  // 卸载兜底清理
  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    },
    []
  );

  return clear;
}