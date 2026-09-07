/**
 * ============================================================
 * 语音房间屏幕共享舞台 (VoiceShareStage)
 * ============================================================
 * 16:9 画框展示房间内共享画面（§3.4 拆分后）：
 * - 全屏 + 原生沉浸（useFullscreenImmersive：Fullscreen API、双击切换、
 *   Esc 原生退出、Android 系统栏沉浸）
 * - 小窗模式（经典视频 PiP；画布绘制管线跨文档继续工作）
 * - 画布渲染管线（useCanvasVideoRenderer：video 解码 + canvas 绘制，
 *   绕开部分 GPU 硬件 overlay 全屏发绿路径）
 * - 共享者：质量档位 / 清晰文字 / 停止共享；观看端：共享声音开关
 *
 * 样式复用 VoiceShareStage.module.css（与拆分前同一份 CSS，视觉零变化）。
 */

import { useRef } from 'react';
import {
  MonitorUp,
  Maximize,
  Minimize,
  Volume2,
  VolumeX,
  Square,
  Type,
  PictureInPicture2,
} from 'lucide-react';
import { useVoice, useVoiceRealtime } from '../context/VoiceContext';
import { useCanvasVideoRenderer } from '../hooks/useCanvasVideoRenderer';
import { useFullscreenImmersive } from '../hooks/useFullscreenImmersive';
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
  const isPresenter = share?.userId === voice.participants[0]?.userId;
  // 共享源类型与捕获帧率：getSettings() 是同步快照，渲染期直接读取
  // （每次渲染读一次 ≈ 原先"每个共享流读一次"的 effect 语义，且省去重置逻辑）
  const trackSettings = share?.stream
    ? (share.stream.getVideoTracks()[0]?.getSettings() as MediaTrackSettings & { displaySurface?: string })
    : undefined;
  /** 共享源类型（monitor/window/browser；合成流等无此字段为 undefined） */
  const surface = trackSettings?.displaySurface;
  /** 捕获源实际帧率（窗口/标签共享被浏览器限制为 30） */
  const captureFps = trackSettings?.frameRate ?? 0;
  const { isFullscreen, toggleFullscreen } = useFullscreenImmersive(stageRef);
  /** 共享者隐藏自己的实时预览（唯一能彻底消除递归镜的方式；观众端不受影响）。
      仅由"全屏 + 共享整屏"自动置位，窗口化舞台始终显示实时画面 */
  const previewHidden = isPresenter && isFullscreen && surface === 'monitor';
  /** 共享者隐藏预览时舞台不渲染直播画面（观众端不受影响） */
  const previewLive = !(isPresenter && previewHidden);
  const { videoRef, canvasSlotRef, pipActive, setPipActive } = useCanvasVideoRenderer({
    stream: share?.stream ?? null,
    live: previewLive,
  });

  if (!share) return null;

  const sharerName = voice.participants.find((p) => p.userId === share.userId)?.username ?? '成员';
  const supportsPip = typeof document !== 'undefined' && !!document.pictureInPictureEnabled;

  /** 小窗模式：经典视频 PiP（原生小窗无地址栏，自带返回到标签页按钮） */
  const enterPip = async () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      await v.requestPictureInPicture();
      setPipActive(true);
    } catch {
      /* 用户取消或不支持 */
    }
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
            {pipActive && (
              <div className={styles.pipPlayingNote}>
                <MonitorUp size={26} />
                画面正在小窗中播放
              </div>
            )}
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
        <span>
          {sharerName} 正在共享{isPresenter ? '（我）' : ''}
        </span>
      </div>

      {/* 发送端实时编码统计：实际帧率/码率/发送分辨率——"选了 60 档但画面糊"时
          一眼看出是哪一环在降级（编码瓶颈掉帧 / 带宽降分辨率）。
          捕获帧率与编码帧率并排显示：捕获 60 但编码 42 = 编码器吞吐瓶颈 */}
      {isPresenter && realtime.shareStats && (
        <div className={styles.statsBar}>
          <span>
            {realtime.shareStats.fps > 0 ? `${realtime.shareStats.fps}fps` : '--fps'}
            {realtime.shareStats.fps > 0 &&
              realtime.shareStats.captureFps > 0 &&
              realtime.shareStats.captureFps !== realtime.shareStats.fps &&
              ` / 捕获${realtime.shareStats.captureFps}`}
          </span>
          <span>·</span>
          <span>
            {realtime.shareStats.bitrate > 0
              ? `${(realtime.shareStats.bitrate / 1_000_000).toFixed(1)}Mbps`
              : '--Mbps'}
          </span>
          {realtime.shareStats.width > 0 && (
            <>
              <span>·</span>
              <span>
                {realtime.shareStats.width}×{realtime.shareStats.height}
              </span>
            </>
          )}
          {realtime.shareStats.resolutionDownscaled && <span className={styles.statsWarn}>已降分辨率</span>}
        </div>
      )}

      {/* 发送端降级提示条（自动纠偏 + 带宽不足 + 帧率达不到；观众端不显示） */}
      {isPresenter &&
        (() => {
          const s = realtime.shareStats;
          if (s?.autoDowngraded) {
            return <div className={styles.hintBar}>CPU 编码受限，已自动切换为流畅 1080p30（可手动切回）</div>;
          }
          if (s?.resolutionDownscaled) {
            return <div className={styles.hintBar}>带宽不足，画质已降级 —— 建议降低档位或检查网络</div>;
          }
          if (voice.shareQuality === '1080p60' && s && s.fps > 0 && s.fps < 45) {
            const cap =
              s.captureFps > 0 ? `（捕获已满 ${s.captureFps}fps，编码器吞吐不足）` : '（硬件/捕获上限）';
            return (
              <div className={styles.hintBar}>
                当前编码 {s.fps}fps，未达 60{cap}—— 流畅观感建议 1080p30
              </div>
            );
          }
          // 仅窗口/标签共享提示帧率上限（Chromium 限制 30fps，请求 60 也没用）；
          // 整屏共享的捕获帧率由显示器/编码器决定，交给上面"未达 60"提示兜底
          if ((surface === 'window' || surface === 'browser') && captureFps > 0 && captureFps < 55) {
            return (
              <div className={styles.hintBar}>
                当前捕获 {captureFps}fps（窗口/标签共享上限 30；共享整屏可达 60）
              </div>
            );
          }
          return null;
        })()}

      <div className={styles.controls} onClick={(e) => e.stopPropagation()}>
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
              onChange={(e) => voice.setShareQuality(e.target.value as ShareQuality)}
              title="观看人数多时建议降档，减轻共享端上行压力"
            >
              {(Object.keys(QUALITY_LABELS) as ShareQuality[]).map((q) => (
                <option key={q} value={q}>
                  {QUALITY_LABELS[q]}
                </option>
              ))}
            </select>
            <button
              className={`${styles.ctlBtn} ${voice.shareSharpText ? styles.ctlOn : ''}`}
              onClick={voice.toggleShareSharpText}
              title={
                voice.shareSharpText
                  ? '切换回流畅模式（适合视频/游戏）'
                  : '清晰文字模式：优先保分辨率（适合文档/代码）'
              }
            >
              <Type size={16} />
              <span>清晰文字</span>
            </button>
            <button
              className={`${styles.ctlBtn} ${styles.stopBtn}`}
              onClick={voice.toggleScreenShare}
              title="停止共享"
            >
              <Square size={13} fill="currentColor" strokeWidth={0} />
              <span>停止共享</span>
            </button>
          </>
        )}

        {supportsPip && !pipActive && (
          <button
            className={styles.ctlBtn}
            onClick={() => {
              void enterPip();
            }}
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
