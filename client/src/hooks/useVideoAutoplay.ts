/**
 * ============================================================
 * 视频延迟自动播放 Hook（useVideoAutoplay）
 * ============================================================
 * 自 client/src/components/post/PostCard.tsx 拆出（纯拆分重构，行为不变）。
 * - videoShouldBeReady 为真且 video 元素就绪后，延迟 delayMs 再加载播放
 *   （完全可见一小会儿后再加载，快速划过不误触）；
 * - 到点后：video.muted = true → loadeddata 时 setVideoReady(true) 并 play()；
 * - 清理语义与原件一致：条件消失 / 卸载时 clearTimeout(delayTimer)、
 *   移除 loadeddata 监听（onReady 可能未触发，保持原样不顺手修）、
 *   video.pause()、setVideoReady(false)；
 * - 渲染期：!videoShouldBeReady && videoReady 时立即重置（原件的渲染期 setState，
 *   受「渲染期 setState 仅允许调整自身状态」模式约束）。
 * ============================================================
 */

import { useEffect, useState, RefObject } from 'react';

export function useVideoAutoplay(
  videoRef: RefObject<HTMLVideoElement | null>,
  videoShouldBeReady: boolean,
  delayMs: number
): boolean {
  const [videoReady, setVideoReady] = useState(false);

  // 条件消失时重置到封面（渲染期调整，与原件渲染期 setState 一致）
  if (!videoShouldBeReady && videoReady) setVideoReady(false);

  useEffect(() => {
    if (!videoShouldBeReady) return;
    const video = videoRef.current;
    if (!video) return;

    let onReady: (() => void) | null = null;

    // 延迟启动：完全可见一小会儿后再加载，划过不误触
    const delayTimer = window.setTimeout(() => {
      video.muted = true;
      onReady = () => {
        setVideoReady(true);
        video.play().catch(() => {});
      };
      video.addEventListener('loadeddata', onReady);
      video.load();
    }, delayMs);

    return () => {
      window.clearTimeout(delayTimer);
      if (onReady) video.removeEventListener('loadeddata', onReady);
      video.pause();
      setVideoReady(false);
    };
  }, [videoShouldBeReady, videoRef, delayMs]);

  return videoReady;
}
