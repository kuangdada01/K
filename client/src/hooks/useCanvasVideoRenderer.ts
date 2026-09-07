/**
 * ============================================================
 * 屏幕共享画布渲染管线 Hook（hooks/useCanvasVideoRenderer）
 * ============================================================
 * 自 VoiceShareStage.tsx 拆出（§3.4，行为逐行不变）：
 * - <video> 解码源接线（autoplay+muted 满足自动播放策略；画面由 canvas 绘制，
 *   绕开部分 GPU 驱动的硬件 overlay 全屏发绿路径）
 * - canvas 命令式生命周期（小窗模式会跨文档移动，不交给 React 管理）
 * - rAF 绘制循环（后台标签 rAF 被节流 → 40ms 定时器兜底，保证小窗画面不冻结）
 * - 视频原生 PiP 退出同步（用户关闭原生小窗时复位 pipActive）
 * - 共享结束：关闭小窗并复位状态
 * ============================================================
 */

import { useEffect, useRef, useState } from 'react';

export function useCanvasVideoRenderer({
  stream,
  live,
}: {
  /** 共享画面流（null = 无共享，清理画布与小窗） */
  stream: MediaStream | null;
  /** 预览是否应显示（共享者全屏+整屏共享时隐藏本地预览，暂停绘制） */
  live: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null); // 命令式创建（小窗模式会跨文档移动）
  const canvasSlotRef = useRef<HTMLDivElement>(null);
  const pipWinRef = useRef<Window | null>(null);
  const [pipActive, setPipActive] = useState(false);

  // 画面流就绪后立即起播（autoplay + muted 满足自动播放策略；声音走独立 audio 元素）
  useEffect(() => {
    const el = videoRef.current;
    if (el && stream && el.srcObject !== stream) {
      el.srcObject = stream;
      el.play().catch(() => {
        /* 手势兜底：任意点击舞台时浏览器会重试 */
      });
    }
    // 依赖含 live：全屏自动隐藏/恢复时占位卡覆盖在画布上方，video 保持解码即可
  }, [stream, live]);

  // canvas 生命周期（命令式）：创建 → 挂进舞台槽位；共享结束移除并关闭小窗
  useEffect(() => {
    if (!stream) {
      if (pipWinRef.current) {
        try {
          pipWinRef.current.close();
        } catch {
          /* 已关闭 */
        }
        pipWinRef.current = null;
      }
      // 异步复位小窗状态（避免在 effect 内同步 setState 触发级联渲染）
      queueMicrotask(() => setPipActive(false));
      canvasRef.current?.remove();
      canvasRef.current = null;
      return;
    }
    let canvas = canvasRef.current;
    if (!canvas) {
      canvas = document.createElement('canvas');
      // background 纯黑 #000：全屏 letterbox（16:9 画面上下留白）用纯黑，与
      // .stage:fullscreen / .canvasSlot 全屏背景一致；非全屏画框 16:9 无 letterbox，
      // 此背景不可见不影响。opacity:0.999 仍保留防硬件 overlay 发绿。
      canvas.style.cssText =
        'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000;opacity:0.999';
      canvasRef.current = canvas;
    }
    const slot = canvasSlotRef.current;
    if (slot && canvas.parentElement !== slot) slot.appendChild(canvas);
  }, [stream]);

  // 用 canvas 绘制视频帧（而非直接显示 <video>）：
  // 部分 GPU/驱动（如新版本 NVIDIA）在视频走硬件 overlay 合成路径时全屏发绿，
  // drawImage 在浏览器内完成 YUV→RGB，颜色确定正确，canvas 也不参与 overlay 提升。
  // 小窗模式下 canvas 位于 PiP 窗口，绘制循环继续工作；
  // 主页面转到后台时 rAF 被节流，改用 40ms 定时器驱动，保证小窗画面不冻结。
  useEffect(() => {
    // 预览隐藏或小窗激活时舞台被不透明提示覆盖，暂停本地绘制（观众画面走 WebRTC 发送，与此无关）
    if (!live || pipActive) return;
    let stopped = false;
    let raf = 0;
    let timer = 0;
    let lastTime = -1;
    const draw = () => {
      if (stopped) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (video && canvas && video.videoWidth > 0) {
        if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
        }
        if (video.currentTime !== lastTime) {
          lastTime = video.currentTime;
          canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
        }
      }
      if (document.hidden)
        timer = window.setTimeout(draw, 40); // 后台标签：rAF 节流，改用定时器
      else raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [stream, live, pipActive]);

  // 视频原生 PiP 退出同步（用户在原生窗口关闭 PiP 时）
  useEffect(() => {
    const onLeave = () => {
      if (!document.pictureInPictureElement) setPipActive(false);
    };
    document.addEventListener('leavepictureinpicture', onLeave);
    return () => document.removeEventListener('leavepictureinpicture', onLeave);
  }, []);

  return { videoRef, canvasRef, canvasSlotRef, pipActive, setPipActive };
}
