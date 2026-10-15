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
import { isNative, setPipEnabled } from '../lib/native';

export function useCanvasVideoRenderer({
  stream,
  live,
  onFrameSize,
}: {
  /** 共享画面流（null = 无共享，清理画布与小窗） */
  stream: MediaStream | null;
  /** 预览是否应显示（共享者全屏+整屏共享时隐藏本地预览，暂停绘制） */
  live: boolean;
  /**
   * 解码帧尺寸的回报（宽高像素，来自 `<video>.videoWidth/Height`）。
   *
   * **为什么不靠接收轨的 `resize` 事件 / `getSettings()`**：对**接收**的视频轨，
   * 这两者在中途分辨率变化（共享者旋转屏幕、换共享源）时并不可靠 —— 事件可能不触发、
   * `getSettings()` 可能停留在旧值。实测症状：手机转去横屏游戏后，观看端画面框停在
   * 竖屏比例，横屏画面被 contain 进一个大竖框里，**只在中间显示一小条**（2026-10-15）。
   * 这里的绘制循环**每帧同步读** `videoWidth/Height`，是解码结果的 ground truth。
   */
  onFrameSize?: (width: number, height: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null); // 命令式创建（小窗模式会跨文档移动）
  const canvasSlotRef = useRef<HTMLDivElement>(null);
  const pipWinRef = useRef<Window | null>(null);
  const [pipActive, setPipActive] = useState(false);

  /**
   * 回调放进 ref：绘制循环的 effect 依赖只留 `[stream, live]`，
   * 回调身份每次渲染都在变，直接进依赖会让循环每帧重启。
   */
  const onFrameSizeRef = useRef(onFrameSize);
  useEffect(() => {
    onFrameSizeRef.current = onFrameSize;
  });

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
    // 暂停绘制的唯一理由：**浏览器版 PiP** 把 <video> 拿到独立小窗去显示，主文档里的画布没人看。
    // 原生系统小窗（本工程实际走的路径）恰好相反：小窗显示的就是这一页，画布**就是**小窗内容，
    // 一旦在这里因为 pipActive 而 return，小窗里就只剩一帧冻住不动的画面（真机踩过）。
    // 判据用 `document.pictureInPictureElement`（浏览器版 PiP 才有），而不是 pipActive。
    if (!live || document.pictureInPictureElement) return;
    /**
     * 启动时先补报一次当前帧尺寸：
     * 换流那一瞬间可能有一帧由**旧闭包**放掉了（它捕获的还是上一路 stream 的身份，
     * 回报会被上层按"不属于本流"拒收）——而那帧已经把画布尺寸改成了新值，
     * 循环里"尺寸变化才回报"的分支之后不会再有动静。这里补一发，保证每路流
     * 至少有一次属于它自己的回报。
     */
    const boot = videoRef.current;
    if (stream && boot && boot.videoWidth > 0) {
      onFrameSizeRef.current?.(boot.videoWidth, boot.videoHeight);
    }
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
          // 帧尺寸变了（首帧 / 中途分辨率变化）→ 回报：上层画面框的比例跟着它走
          onFrameSizeRef.current?.(video.videoWidth, video.videoHeight);
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
  }, [stream, live]);

  // 视频原生 PiP 退出同步（用户在原生窗口关闭 PiP 时）
  useEffect(() => {
    const onLeave = () => {
      if (!document.pictureInPictureElement) setPipActive(false);
    };
    document.addEventListener('leavepictureinpicture', onLeave);
    return () => document.removeEventListener('leavepictureinpicture', onLeave);
  }, []);

  // 原生宿主：声明"现在适合画中画" —— 共享画面在放时，用户按 Home 会进系统小窗。
  // WebView 不支持网页版 PiP API（requestPictureInPicture），所以只能走原生系统画中画。
  useEffect(() => {
    if (!isNative()) return;
    void setPipEnabled(Boolean(stream) && live).catch(() => {});
    return () => {
      void setPipEnabled(false).catch(() => {});
    };
  }, [stream, live]);

  return { videoRef, canvasRef, canvasSlotRef, pipActive, setPipActive };
}
