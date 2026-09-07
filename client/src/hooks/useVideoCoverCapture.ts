/**
 * ============================================================
 * 视频封面截帧 Hook（hooks/useVideoCoverCapture）
 * ============================================================
 * 自 CreatePost.tsx 拆出（行为逐字节不变）：
 * - extractFrame：720p 画布上限（防 4K 画布 WebView OOM）、同值 seek 已停在
 *   目标帧时直接截取（否则 seeked 不触发、封面永远生成不出来）、2s seek 超时兜底
 * - handleVideoLoaded：300ms 二次判定黑屏（HEVC 在 WebView 解码失败）+
 *   150MB 大文件标记（跳过自动截帧防 OOM）+ 时长读取（Infinity 保护）
 * - handleVideoError / handleCoverTimeChange / handleCoverFileSelect
 *
 * P2 修复：原 extractFrame 的 seek 超时定时器在组件卸载后未清理，搬移时改为
 * ref 跟踪最新定时器并在 effect cleanup 中清理（行为不变，只是不泄漏）。
 *
 * 依赖 from useMediaDraft 注入（本 hook 不持有媒体草稿状态）：
 * - videoFile（150MB 判定）、videoCoverPreview + setVideoCoverFile/setVideoCoverPreview
 *   （截帧与手动上传写入封面）、setCoverTime/setVideoError（滑动时间/解码状态）
 */

import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, Dispatch, RefObject, SetStateAction } from 'react';
import { showToast } from '../components/ui/Toast';

export interface UseVideoCoverCaptureParams {
  videoRef: RefObject<HTMLVideoElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  /** 当前视频文件（150MB 大文件判定；随渲染更新） */
  videoFile: File | null;
  /** 当前封面预览 URL（截帧/上传前 revoke 旧 URL 用） */
  videoCoverPreview: string | null;
  setVideoCoverFile: Dispatch<SetStateAction<File | null>>;
  setVideoCoverPreview: Dispatch<SetStateAction<string | null>>;
  setCoverTime: Dispatch<SetStateAction<number>>;
  setVideoError: Dispatch<SetStateAction<boolean>>;
}

export interface UseVideoCoverCaptureResult {
  /** 视频时长（秒；handleVideoLoaded 读取，供封面时间轴 max 用） */
  videoDuration: number;
  handleVideoLoaded: () => void;
  handleVideoError: () => void;
  handleCoverTimeChange: (e: ChangeEvent<HTMLInputElement>) => void;
  handleCoverFileSelect: (e: ChangeEvent<HTMLInputElement>) => void;
}

export function useVideoCoverCapture({
  videoRef,
  canvasRef,
  videoFile,
  videoCoverPreview,
  setVideoCoverFile,
  setVideoCoverPreview,
  setCoverTime,
  setVideoError,
}: UseVideoCoverCaptureParams): UseVideoCoverCaptureResult {
  const [videoDuration, setVideoDuration] = useState(0);

  // P2：seek 超时定时器经 ref 跟踪，组件卸载时清理，避免定时器泄漏
  const seekTimeoutRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (seekTimeoutRef.current !== null) {
        window.clearTimeout(seekTimeoutRef.current);
        seekTimeoutRef.current = null;
      }
    };
  }, []);

  // 从视频中截取指定时间的帧（限制画布到 720p 以防 4K 画布 OOM 闪退）
  // 注意：同值 seek（如 loadeddata 后截第 0 帧）不会触发 seeked 事件，
  // 必须先判断"已停在目标帧"直接截取，否则封面永远生成不出来
  const extractFrame = (time: number) => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    const capture = () => {
      try {
        const vw = video.videoWidth || 1280;
        const vh = video.videoHeight || 720;
        // 封顶 720p：x264 封面不需要 4K，画布内存与面积成正比，4K画布约 33MB 易触发 WebView OOM
        const maxW = 720;
        let cw = vw;
        let ch = vh;
        if (vw > maxW) {
          cw = maxW;
          ch = Math.round((vh * maxW) / vw);
        }
        canvas.width = cw;
        canvas.height = ch;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(video, 0, 0, cw, ch);
        canvas.toBlob(
          (blob) => {
            if (!blob) return;
            try {
              const file = new File([blob], 'cover.jpg', { type: 'image/jpeg' });
              if (videoCoverPreview) {
                try {
                  URL.revokeObjectURL(videoCoverPreview);
                } catch {}
              }
              setVideoCoverFile(file);
              setVideoCoverPreview(URL.createObjectURL(file));
            } catch (e) {
              console.error('封面 blob 创建失败', e);
              showToast('封面截取失败，可手动上传封面或直接发布（服务端会兜底生成）');
            }
          },
          'image/jpeg',
          0.75
        );
      } catch (e) {
        console.error('extractFrame 失败', e);
        showToast('封面截取失败，可手动上传封面');
      }
    };

    try {
      // 已停在目标帧附近且帧数据可用：直接截取
      if (Math.abs(video.currentTime - time) < 0.05 && video.readyState >= 2) {
        video.onseeked = null;
        capture();
        return;
      }
      video.onseeked = capture;
      // 超大文件 seek 可能卡死，设置 2s 超时兜底清理
      const t = window.setTimeout(() => {
        if (video.onseeked === capture) {
          video.onseeked = null;
          console.warn('video seek 超时，跳过截帧');
        }
      }, 2000);
      seekTimeoutRef.current = t;
      const orig = capture;
      video.onseeked = () => {
        window.clearTimeout(t);
        if (seekTimeoutRef.current === t) seekTimeoutRef.current = null;
        orig();
      };
      video.currentTime = time;
    } catch (e) {
      console.error('video seek 失败', e);
    }
  };

  const handleCoverTimeChange = (e: ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    setCoverTime(time);
    extractFrame(time);
  };

  const handleCoverFileSelect = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      if (videoCoverPreview) {
        try {
          URL.revokeObjectURL(videoCoverPreview);
        } catch {}
      }
      setVideoCoverFile(file);
      setVideoCoverPreview(URL.createObjectURL(file));
    } catch (e) {
      console.error('封面预览失败', e);
      showToast('封面加载失败');
    } finally {
      e.target.value = '';
    }
  };

  const handleVideoLoaded = () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      // duration 可能是 Infinity（直播流/异常），做保护
      const d = Number.isFinite(video.duration) ? video.duration : 0;
      setVideoDuration(d);
      // 检测黑屏：若 videoWidth 为 0 说明解码失败（HEVC 在 WebView 不支持），延迟 300ms 再判一次避免竞态
      if (video.videoWidth === 0 || video.videoHeight === 0) {
        setTimeout(() => {
          if (video.videoWidth === 0 || video.videoHeight === 0) {
            console.warn('videoWidth 0，判定为解码失败');
            setVideoError(true);
            showToast('该视频预览不支持（HEVC等），可直接下一步，发布后服务端自动转码');
          } else {
            setVideoError(false);
            if ((videoFile?.size || 0) <= 150 * 1024 * 1024) extractFrame(0);
          }
        }, 300);
        return;
      }
      setVideoError(false);
      // 仅在视频可解码且非超大文件时自动截帧；超大文件跳过以防 OOM（不留日志），依赖服务端兜底
      const isLarge = (videoFile?.size || 0) > 150 * 1024 * 1024;
      if (!isLarge) {
        extractFrame(0);
      }
    } catch (e) {
      console.error('handleVideoLoaded 失败', e);
      setVideoError(true);
    }
  };

  const handleVideoError = () => {
    console.error('视频解码失败，可能是 HEVC/编码不支持');
    setVideoError(true);
    showToast('该视频编码预览失败，仍可尝试发布（服务端会自动转码）');
    // 不清空 file，允许用户直接发布，服务端会转码并生成封面
  };

  return {
    videoDuration,
    handleVideoLoaded,
    handleVideoError,
    handleCoverTimeChange,
    handleCoverFileSelect,
  };
}
