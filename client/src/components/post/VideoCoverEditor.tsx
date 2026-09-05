/**
 * ============================================================
 * 视频封面编辑步骤（VideoCoverEditor，CreatePost 第 2 步）
 * ============================================================
 * 从 CreatePost 抽出的完整第 2 步视图：视频预览（含解码失败回退与重试）、
 * 手动上传封面、滑动时间轴截帧。截帧/解码逻辑留在 CreatePost（持有视频状态）。
 */
import type { ChangeEvent, RefObject } from 'react';
import { ImagePlus, Video } from 'lucide-react';
import ConfirmDialog from '../ui/ConfirmDialog';
import styles from './CreatePost.module.css';
import composer from './PostComposer.module.css';

interface VideoCoverEditorProps {
  closing: boolean;
  videoFile: File;
  videoPreview: string | null;
  videoError: boolean;
  videoCoverPreview: string | null;
  videoDuration: number;
  coverTime: number;
  videoRef: RefObject<HTMLVideoElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  coverInputRef: RefObject<HTMLInputElement | null>;
  onVideoLoaded: () => void;
  onVideoError: () => void;
  onCoverTimeChange: (e: ChangeEvent<HTMLInputElement>) => void;
  onCoverFileSelect: (e: ChangeEvent<HTMLInputElement>) => void;
  onRetryPreview: () => void;
  onBack: () => void;
  onNext: () => void;
  showDiscardConfirm: boolean;
  onDiscardConfirm: () => void;
  onDiscardCancel: () => void;
}

export default function VideoCoverEditor({
  closing,
  videoFile,
  videoPreview,
  videoError,
  videoCoverPreview,
  videoDuration,
  coverTime,
  videoRef,
  canvasRef,
  coverInputRef,
  onVideoLoaded,
  onVideoError,
  onCoverTimeChange,
  onCoverFileSelect,
  onRetryPreview,
  onBack,
  onNext,
  showDiscardConfirm,
  onDiscardConfirm,
  onDiscardCancel,
}: VideoCoverEditorProps) {
  return (
    <div className={`${composer.overlay}${closing ? ` ${composer.closing}` : ''}`}>
      <div className={`${composer.dialog}${closing ? ` ${composer.closing}` : ''}`}>
        <div className={composer.overlayHeader}>
          <button className={composer.overlayBtn} data-back onClick={onBack}>
            后退
          </button>
          <span className={composer.overlayTitle}>选择封面</span>
          <button className={`${composer.overlayBtn} ${composer.primary}`} onClick={onNext}>
            下一步
          </button>
        </div>
        <div className={styles.coverLayout}>
          <div className={styles.coverLeft}>
            <div className={styles.coverPreview}>
              {videoPreview && !videoError ? (
                <video
                  key={videoPreview}
                  ref={videoRef}
                  src={videoPreview}
                  onLoadedMetadata={() => {
                    // 强制触发一次 seek 到 0.2s 避免首帧纯黑
                    try {
                      const v = videoRef.current;
                      if (v && v.currentTime < 0.1) v.currentTime = 0.2;
                    } catch {}
                    onVideoLoaded();
                  }}
                  onCanPlay={() => {
                    try {
                      videoRef.current?.pause();
                    } catch {}
                  }}
                  onError={onVideoError}
                  className={styles.coverVideo}
                  controls
                  preload="auto"
                  playsInline
                  muted
                  autoPlay={false}
                  style={{ background: '#000', display: 'block', width: '100%' }}
                />
              ) : (
                <div
                  className={styles.coverVideo}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: '#1a1a1a',
                    color: '#ccc',
                    fontSize: 13,
                    padding: 16,
                    textAlign: 'center',
                    gap: 8,
                    border: videoError ? '1px dashed #666' : 'none',
                  }}
                >
                  {videoFile ? (
                    <>
                      <Video size={32} style={{ opacity: 0.6 }} />
                      <div style={{ fontWeight: 600 }}>
                        {videoFile.name} ({(videoFile.size / 1024 / 1024).toFixed(1)}MB)
                      </div>
                      {videoError ? (
                        <div style={{ fontSize: 12, color: '#ffb74d' }}>
                          该视频无法预览（常见于 iPhone HEVC/MOV 或 WebView 解码限制）
                          <br />
                          可直接点“下一步”或手动上传封面，发布后服务端自动转码
                        </div>
                      ) : (
                        <div style={{ fontSize: 12, opacity: 0.8 }}>
                          预览加载中…（若持续黑屏请点“下一步”手动上传封面）
                        </div>
                      )}
                      <button
                        onClick={onRetryPreview}
                        style={{
                          marginTop: 8,
                          padding: '6px 12px',
                          background: 'var(--accent)',
                          color: 'var(--on-accent)',
                          border: 'none',
                          borderRadius: 6,
                          fontSize: 12,
                        }}
                      >
                        重试预览
                      </button>
                    </>
                  ) : (
                    '无预览'
                  )}
                </div>
              )}
            </div>
          </div>
          <div className={styles.coverRight}>
            <div className={styles.coverSection}>
              <div className={styles.coverSectionTitle}>上传封面图片</div>
              <button
                className={styles.uploadBtn}
                onClick={() => coverInputRef.current?.click()}
                style={{ width: '100%' }}
              >
                <ImagePlus size={18} />
                从电脑选择
              </button>
              {videoCoverPreview && (
                <img src={videoCoverPreview} alt="封面预览" className={styles.coverImage} />
              )}
              <input
                ref={coverInputRef}
                type="file"
                accept="image/jpeg,image/jpg,image/png,image/gif,image/webp,image/avif,image/heic,image/heif"
                style={{ display: 'none' }}
                onChange={onCoverFileSelect}
              />
            </div>
            <div className={styles.coverSection}>
              <div className={styles.coverSectionTitle}>或从视频截取</div>
              <canvas ref={canvasRef} style={{ display: 'none' }} />
              <div className={styles.coverSliderRow}>
                <input
                  type="range"
                  min="0"
                  max={videoDuration || 1}
                  step="0.1"
                  value={coverTime}
                  onChange={onCoverTimeChange}
                  className={styles.coverSlider}
                />
                <span className={styles.coverTime}>{coverTime.toFixed(1)}s</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {showDiscardConfirm && (
        <ConfirmDialog
          message="确定要放弃此次分享吗？"
          onConfirm={onDiscardConfirm}
          onCancel={onDiscardCancel}
        />
      )}
    </div>
  );
}
