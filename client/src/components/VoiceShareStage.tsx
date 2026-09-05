/**
 * ============================================================
 * 语音房间屏幕共享舞台 (VoiceShareStage)
 * ============================================================
 * 16:9 画框展示房间内共享画面，支持：
 * - 全屏（Fullscreen API，双击画面切换，Esc 原生退出）
 * - 小窗模式（Document Picture-in-Picture，画面浮于桌面，Chrome 116+；
 *   不支持时回退经典视频 PiP）
 * - 共享者：质量档位 / 清晰文字 / 停止共享；观看端：共享声音开关
 *
 * 渲染管线：<video> 只做解码源（1px 藏在角落），画面由 canvas 绘制——
 * 部分新显卡驱动在全屏视频走硬件 overlay 合成路径时发绿，canvas 管线绕开该路径。
 * 小窗模式下 canvas 元素会被搬进 PiP 窗口（绘制循环继续工作），因此 canvas
 * 用命令式创建/挂载，不交给 React 管理（避免跨文档移动引发卸载异常）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { MonitorUp, Maximize, Minimize, Volume2, VolumeX, Square, Type, PictureInPicture2 } from 'lucide-react';
import { useVoice, useVoiceRealtime } from '../context/VoiceContext';
import type { ShareQuality } from '../voice/VoiceSession';
import styles from './VoiceShareStage.module.css';

const QUALITY_LABELS: Record<ShareQuality, string> = {
  '1080p60': '极清 1080p60',
  '1080p30': '流畅 1080p30',
  '720p30': '省流 720p30',
};


export default function VoiceShareStage() {
  const voice = useVoice();
  const realtime = useVoiceRealtime();
  const share = voice.share;
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null); // 命令式创建（小窗模式会跨文档移动）
  const canvasSlotRef = useRef<HTMLDivElement>(null);
  const pipWinRef = useRef<Window | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [pipActive, setPipActive] = useState(false);
  const isPresenter = share?.userId === voice.participants[0]?.userId;
  // 共享源类型与捕获帧率：getSettings() 是同步快照，渲染期直接读取
  // （每次渲染读一次 ≈ 原先"每个共享流读一次"的 effect 语义，且省去重置逻辑）
  const trackSettings = share?.stream
    ? share.stream.getVideoTracks()[0]?.getSettings() as MediaTrackSettings & { displaySurface?: string }
    : undefined;
  /** 共享源类型（monitor/window/browser；合成流等无此字段为 undefined） */
  const surface = trackSettings?.displaySurface;
  /** 捕获源实际帧率（窗口/标签共享被浏览器限制为 30） */
  const captureFps = trackSettings?.frameRate ?? 0;
  /** 共享者隐藏自己的实时预览（唯一能彻底消除递归镜的方式；观众端不受影响）。
      仅由"全屏 + 共享整屏"自动置位，窗口化舞台始终显示实时画面 */
  const previewHidden = isPresenter && isFullscreen && surface === 'monitor';
  /** 共享者隐藏预览时舞台不渲染直播画面（观众端不受影响） */
  const previewLive = !(isPresenter && previewHidden);
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
  const applyImmersive = useCallback((on: boolean) => {
    const bridge = (window as unknown as { AndroidBridge?: { setImmersiveMode?: (v: boolean) => void } }).AndroidBridge;
    bridge?.setImmersiveMode?.(on);
    if (on) refreshThemeColor();
  }, [refreshThemeColor]);

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

  // 画面流就绪后立即起播（autoplay + muted 满足自动播放策略；声音走独立 audio 元素）
  useEffect(() => {
    const el = videoRef.current;
    if (el && share?.stream && el.srcObject !== share.stream) {
      el.srcObject = share.stream;
      el.play().catch(() => { /* 手势兜底：任意点击舞台时浏览器会重试 */ });
    }
    // 依赖含 previewLive：全屏自动隐藏/恢复时占位卡覆盖在画布上方，video 保持解码即可
  }, [share?.stream, previewLive]);

  // canvas 生命周期（命令式）：创建 → 挂进舞台槽位；共享结束移除并关闭小窗
  useEffect(() => {
    if (!share?.stream) {
      if (pipWinRef.current) { try { pipWinRef.current.close(); } catch { /* 已关闭 */ } pipWinRef.current = null; }
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
      canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000;opacity:0.999';
      canvasRef.current = canvas;
    }
    const slot = canvasSlotRef.current;
    if (slot && canvas.parentElement !== slot) slot.appendChild(canvas);
  }, [share?.stream]);

  // 用 canvas 绘制视频帧（而非直接显示 <video>）：
  // 部分 GPU/驱动（如新版本 NVIDIA）在视频走硬件 overlay 合成路径时全屏发绿，
  // drawImage 在浏览器内完成 YUV→RGB，颜色确定正确，canvas 也不参与 overlay 提升。
  // 小窗模式下 canvas 位于 PiP 窗口，绘制循环继续工作；
  // 主页面转到后台时 rAF 被节流，改用 40ms 定时器驱动，保证小窗画面不冻结。
  useEffect(() => {
    // 预览隐藏或小窗激活时舞台被不透明提示覆盖，暂停本地绘制（观众画面走 WebRTC 发送，与此无关）
    if (!previewLive || pipActive) return;
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
      if (document.hidden) timer = window.setTimeout(draw, 40); // 后台标签：rAF 节流，改用定时器
      else raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [share?.stream, previewLive, pipActive]);

  // 视频原生 PiP 退出同步（用户在原生窗口关闭 PiP 时）——必须在 early return 之前声明（Hooks 规则）
  useEffect(() => {
    const onLeave = () => { if (!document.pictureInPictureElement) setPipActive(false); };
    document.addEventListener('leavepictureinpicture', onLeave);
    return () => document.removeEventListener('leavepictureinpicture', onLeave);
  }, []);

  if (!share) return null;

  const sharerName = voice.participants.find(p => p.userId === share.userId)?.username ?? '成员';
  const supportsPip = typeof document !== 'undefined' && !!document.pictureInPictureEnabled;

  const toggleFullscreen = () => {
    const el = stageRef.current;
    if (!el) return;
    // 退出：主动意图清空 + 恢复系统栏（不依赖 fullscreenchange 时序）
    if (document.fullscreenElement || fullscreenIntentRef.current) {
      fullscreenIntentRef.current = false;
      document.exitFullscreen().catch(() => { /* 已退出 */ });
      setIsFullscreen(false);
      applyImmersive(false);
      return;
    }
    const webkitEl = el as HTMLDivElement & { webkitRequestFullscreen?: () => void };
    // navigationUI: "hide" 让浏览器完全隐藏导航 UI（地址栏 + 状态栏），实现真正的
    // 沉浸式全屏——否则默认 "auto" 下 Android Chrome 会残留状态栏位置（"状态栏图标
    // 隐藏了但位置变黑"的根因）；app 端对应 MainActivity 的 hide(systemBars())。
    const doFs = () => (el.requestFullscreen
      ? el.requestFullscreen({ navigationUI: 'hide' } as FullscreenOptions)
      : webkitEl.webkitRequestFullscreen?.());
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
        .catch(() => { /* 拒绝则忽略 */ });
    } else {
      // 老 WebView 的 webkitRequestFullscreen 无 Promise：标记意图，靠 fullscreenchange 兜底
      fullscreenIntentRef.current = true;
      applyImmersive(true);
    }
  };

  /** 小窗模式：经典视频 PiP（原生小窗无地址栏，自带返回到标签页按钮） */
  const enterPip = async () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      await v.requestPictureInPicture();
      setPipActive(true);
    } catch { /* 用户取消或不支持 */ }
  };

  return (
    <div
      ref={stageRef}
      className={`${styles.stage} ${isFullscreen ? styles.fullscreen : ''}`}
      onDoubleClick={toggleFullscreen}
    >
      {share.stream ? (
        <>
          {/* 解码源：缩小到 1px 藏在角落，保持解码活跃；画面实际由上方 canvas 绘制。
              隐藏预览/小窗模式 = 上方盖一层不透明占位卡（元素不卸载，恢复显示零延迟） */}
          <video ref={videoRef} className={styles.sourceVideo} autoPlay playsInline muted />
          <div ref={canvasSlotRef} className={styles.canvasSlot}>
            {pipActive && <div className={styles.pipPlayingNote}><MonitorUp size={26} />画面正在小窗中播放</div>}
          </div>
          {!previewLive && !pipActive && (
            <div className={styles.previewHidden}>
              <MonitorUp size={30} />
              <div className={styles.veilTitle}>预览已隐藏</div>
              <div className={styles.veilSub}>观众看到的画面正常；共享仍在进行</div>
            </div>
          )}
        </>
      ) : (
        <div className={styles.loading}>
          <MonitorUp size={28} />
          <span>正在接收 {sharerName} 的共享画面…</span>
        </div>
      )}

      {/* 共享者全屏自看防递归：整屏共享 + 全屏时递归区域最大，色彩误差逐层
          叠乘最明显（窗口化经用户验证正常，不加遮罩）。遮罩让误差按比例衰减
          收敛，观众看到的画面亮度不受影响。 */}
      {isPresenter && !previewHidden && !pipActive && isFullscreen && (
        <div className={styles.presenterVeil}>
          <MonitorUp size={30} />
          <div className={styles.veilTitle}>你正在共享屏幕</div>
          <div className={styles.veilSub}>观众看到的画面亮度正常（此处调暗以避免递归画面叠色）</div>
        </div>
      )}

      <div className={styles.badge}>
        <MonitorUp size={13} />
        <span>{sharerName} 正在共享{isPresenter ? '（我）' : ''}</span>
      </div>

      {/* 发送端实时编码统计：实际帧率/码率/发送分辨率——"选了 60 档但画面糊"时
          一眼看出是哪一环在降级（编码瓶颈掉帧 / 带宽降分辨率）。
          捕获帧率与编码帧率并排显示：捕获 60 但编码 42 = 编码器吞吐瓶颈 */}
      {isPresenter && realtime.shareStats && (
        <div className={styles.statsBar}>
          <span>
            {realtime.shareStats.fps > 0 ? `${realtime.shareStats.fps}fps` : '--fps'}
            {realtime.shareStats.fps > 0
              && realtime.shareStats.captureFps > 0
              && realtime.shareStats.captureFps !== realtime.shareStats.fps
              && ` / 捕获${realtime.shareStats.captureFps}`}
          </span>
          <span>·</span>
          <span>{realtime.shareStats.bitrate > 0 ? `${(realtime.shareStats.bitrate / 1_000_000).toFixed(1)}Mbps` : '--Mbps'}</span>
          {realtime.shareStats.width > 0 && (
            <>
              <span>·</span>
              <span>{realtime.shareStats.width}×{realtime.shareStats.height}</span>
            </>
          )}
          {realtime.shareStats.resolutionDownscaled && <span className={styles.statsWarn}>已降分辨率</span>}
        </div>
      )}

      {/* 发送端降级提示条（自动纠偏 + 带宽不足 + 帧率达不到；观众端不显示） */}
      {isPresenter && (() => {
        const s = realtime.shareStats;
        if (s?.autoDowngraded) {
          return <div className={styles.hintBar}>CPU 编码受限，已自动切换为流畅 1080p30（可手动切回）</div>;
        }
        if (s?.resolutionDownscaled) {
          return <div className={styles.hintBar}>带宽不足，画质已降级 —— 建议降低档位或检查网络</div>;
        }
        if (voice.shareQuality === '1080p60' && s && s.fps > 0 && s.fps < 45) {
          const cap = s.captureFps > 0 ? `（捕获已满 ${s.captureFps}fps，编码器吞吐不足）` : '（硬件/捕获上限）';
          return <div className={styles.hintBar}>当前编码 {s.fps}fps，未达 60{cap}—— 流畅观感建议 1080p30</div>;
        }
        // 仅窗口/标签共享提示帧率上限（Chromium 限制 30fps，请求 60 也没用）；
        // 整屏共享的捕获帧率由显示器/编码器决定，交给上面"未达 60"提示兜底
        if ((surface === 'window' || surface === 'browser') && captureFps > 0 && captureFps < 55) {
          return <div className={styles.hintBar}>当前捕获 {captureFps}fps（窗口/标签共享上限 30；共享整屏可达 60）</div>;
        }
        return null;
      })()}

      <div className={styles.controls} onClick={e => e.stopPropagation()}>
        {share.audio && (
          <button
            className={`${styles.ctlBtn} ${!voice.shareMuted ? styles.ctlOn : ''}`}
            onClick={voice.toggleShareMuted}
            title={voice.shareMuted ? '开启共享声音' : '关闭共享声音'}
          >
            {voice.shareMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </button>
        )}

        {isPresenter && (
          <>
            <select
              className={styles.qualitySelect}
              value={voice.shareQuality}
              onChange={e => voice.setShareQuality(e.target.value as ShareQuality)}
              title="观看人数多时建议降档，减轻共享端上行压力"
            >
              {(Object.keys(QUALITY_LABELS) as ShareQuality[]).map(q => (
                <option key={q} value={q}>{QUALITY_LABELS[q]}</option>
              ))}
            </select>
            <button
              className={`${styles.ctlBtn} ${voice.shareSharpText ? styles.ctlOn : ''}`}
              onClick={voice.toggleShareSharpText}
              title={voice.shareSharpText ? '切换回流畅模式（适合视频/游戏）' : '清晰文字模式：优先保分辨率（适合文档/代码）'}
            >
              <Type size={16} />
              <span>清晰文字</span>
            </button>
            <button className={`${styles.ctlBtn} ${styles.stopBtn}`} onClick={voice.toggleScreenShare} title="停止共享">
              <Square size={13} fill="currentColor" strokeWidth={0} />
              <span>停止共享</span>
            </button>
          </>
        )}

        {supportsPip && !pipActive && (
          <button
            className={styles.ctlBtn}
            onClick={() => { void enterPip(); }}
            title="小窗模式（浮于桌面，可边看共享边做其他事）"
          >
            <PictureInPicture2 size={16} />
          </button>
        )}

        <button
          className={styles.ctlBtn}
          onClick={toggleFullscreen}
          title={isFullscreen ? '退出全屏（Esc）' : '全屏显示（双击画面也可切换）'}
        >
          {isFullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
        </button>
      </div>
    </div>
  );
}
