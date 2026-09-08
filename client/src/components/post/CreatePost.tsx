/**
 * ============================================================
 * 创建帖子组件 (CreatePost)
 * ============================================================
 * 创建帖子的3步流程模态框
 *
 * 步骤:
 * 1. 选择媒体: 选择图片（最多9张）或视频
 * 2. 视频封面: 从视频截取或上传自定义封面（仅视频帖子）
 * 3. 编辑分享: 添加描述、高级设置（关闭评论）
 *
 * 特性:
 * - 图片拖拽排序（按下即拖，实时重排）
 * - 视频封面截取（滑动时间轴选择帧）
 * - 放弃确认对话框
 * - 关闭动画效果
 *
 * 职责拆分（阶段 3A）:
 * - useComposerLifecycle: 关闭/放弃/历史条目
 * - useMediaDraft: 图片/视频草稿状态、文件处理与 blob 生命周期
 * - useVideoCoverCapture: 视频封面截帧/解码状态
 * - MediaPickerStep: 第 1 步（选择媒体）展示
 * - 本组件: 步骤编排 + 提交（FormData 组装/分片上传/进度）
 * ============================================================
 */

import { useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Video } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { useQueryClient } from '@tanstack/react-query';
import { getApiErrorMessage } from '../../api/http';
import VideoCoverEditor from './VideoCoverEditor';
import PostDescriptionPanel from './PostDescriptionPanel';
import MediaPickerStep from './MediaPickerStep';
import { useAuth } from '../../context/AuthContext';
import { useVoiceInRoom } from '../../context/VoiceContext';
import { useEvent } from '../../context/EventContext';
import { events } from '../../state/events';
import { updatePostsFeed } from '../../hooks/usePostsFeed';
import { showToast } from '../ui/Toast';
import { useComposerLifecycle } from '../../hooks/useComposerLifecycle';
import { useMediaDraft } from '../../hooks/useMediaDraft';
import { useVideoCoverCapture } from '../../hooks/useVideoCoverCapture';
import { usePreviewAutoRetry } from '../../hooks/usePreviewAutoRetry';
import { usePreviewDecodeWatchdog } from '../../hooks/usePreviewDecodeWatchdog';
import { createImagePost, createVideoPost, createVideoPostChunked, createVideoPostFromTempUrl, getTempVideoStatus } from '../../api/posts';
import { IMAGE_PREVIEW_FALLBACK } from '../../utils';
import composer from './PostComposer.module.css';

export default function CreatePost() {
  const { user } = useAuth();
  const inRoom = useVoiceInRoom();
  const { closeCreate } = useEvent();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 统一的图片项：{ url, file }。B2 修复——拖拽重排这一个数组，
  // 上传时按其遍历，保证"所见即所得"（此前 imageFiles/imagePreviews 两个
  // 平行数组导致拖拽排序不反映在实际上传顺序）。
  interface ImageItem {
    url: string;
    file: File;
  }

  // 步骤: 1 = 选择媒体, 2 = 视频封面, 3 = 编辑分享
  const [step, setStep] = useState(1);
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [closeComments, setCloseComments] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [currentImageIndex, setCurrentImageIndex] = useState(0);

  // 媒体草稿：图片/视频状态、文件处理（9图截断/10MB/300MB 校验、HEIC 预览）、
  // blob 生命周期（删除 revoke + 卸载兜底 revoke）（自 hooks/useMediaDraft 拆出，行为不变）
  const {
    images,
    setImages,
    videoFile,
    videoPreview,
    setVideoPreview,
    tempVideoUrl,
    tempVideoUploading,
    waitForTempVideoUpload,
    videoCoverFile,
    videoCoverPreview,
    coverTime,
    setCoverTime,
    videoError,
    setVideoError,
    setVideoCoverFile,
    setVideoCoverPreview,
    handleFileSelect,
    handleRemoveImage,
    handleVideoSelect,
    handleRemoveVideo,
    resetDraft,
  } = useMediaDraft<ImageItem>({
    makeItem: (url, file) => ({ url, file }),
    // 选择视频后自动跳转到封面编辑（原 setStep(2)，成功/失败路径均要跳转）
    onVideoSelected: () => setStep(2),
  });

  // 移动端浏览器（Edge 等）blob: 视频解码失败（P5 修复）：切换到已后台上传的
  // /uploads/temp HTTP 预览（服务端 Range 通道与信息流视频一致，各浏览器可靠）。
  // 切换不可逆：一旦切到 HTTP，后续无论成功失败都不再回退 blob，避免死循环。
  const [tempActive, setTempActive] = useState(false);
  // 重试计数：并入 video key 强制重新挂载（temp 通道重试 / blob revoke 重建双路径）
  const [previewRetry, setPreviewRetry] = useState(0);
  // 后端返回相对路径；video src 必须绝对（SPA 路由下相对路径会解析错位）。
  // tempActive 已置位但 tempVideoUrl 未就绪（仍在后台上传）时 src 保持 blob；
  // 上传落地后 tempVideoUrl 变化 → key/src 变化 → video 自动重新挂载切换成功。
  // ⚠️ temp URL 带 ?v=previewRetry 版本参数：转码完成是"同 URL 原地替换内容"，
  // 浏览器可能缓存转码前（4K/HEVC 不可播）的响应/媒体缓存，重载同 URL 会
  // 反复拿到旧内容。版本参数随每次重试递增，强制重新拉取转码后的新文件。
  const effectiveVideoSrc =
    tempActive && tempVideoUrl
      ? `${window.location.origin}${tempVideoUrl}?v=${previewRetry}`
      : videoPreview;
  const handleVideoPreviewError = () => {
    // 明确报错：解除看门狗（避免超时重复判定）
    clearDecodeWatchdog();
    if (!tempActive) {
      // blob 通道首次失败：切换到 HTTP temp 通道，进入转码等待（保留原提示文案）
      setTempActive(true);
      setWaitingTranscode(true);
      handleVideoError();
    } else {
      // temp 通道失败（转码未完成等）：静默置失败态显示等待提示；
      // 等待链由 waitingTranscode 独立持有，不受失败信号翻转影响
      setVideoError(true);
    }
  };

  // 转码等待状态（生命周期解耦的核心）：进入 temp 通道后置 true，
  // **只有 canplay（真正可播放）才置 false**。轮询链由它驱动——
  // metadata 成功、黑屏、onError 等中间状态都不会杀死等待链。
  const [waitingTranscode, setWaitingTranscode] = useState(false);
  const [transcoding, setTranscoding] = useState(false);
  const pollTempStatus = async (): Promise<'done' | 'pending' | 'error'> => {
    // 上传未完成（tempVideoUrl 未就绪）或文件暂不可查：视为等待中
    if (!tempVideoUrl) {
      setTranscoding(true);
      return 'pending';
    }
    try {
      const data = await getTempVideoStatus(tempVideoUrl);
      // 容错：304/异常响应可能无 body（status 缺失）——按等待处理，下一轮再查
      const ready = data?.status === 'done';
      setTranscoding(!ready);
      return ready ? 'done' : 'pending';
    } catch {
      // 网络抖动：保持等待，下一轮轮询重试
      setTranscoding(true);
      return 'pending';
    }
  };
  const resetPreviewAutoRetry = usePreviewAutoRetry({
    active: tempActive,
    waiting: waitingTranscode,
    retry: () => {
      setVideoError(false);
      setPreviewRetry((n) => n + 1);
    },
    pollStatus: pollTempStatus,
  });

  // 等待转码期间强制显示提示面板（不渲染 video）：避免"黑屏视频 ↔ 面板"
  // 反复横跳让用户误以为卡死。转码完成（done→retry）后 transcoding=false，
  // 恢复渲染 video 尝试加载。
  const previewPanelVisible = videoError || (waitingTranscode && transcoding);

  // 解码看门狗：video 元素挂载后（src/key 变化）6s 内既无 canplay 也无 error
  // （Edge 对超规格 H.264 的解码器挂起：metadata/videoWidth 正常但黑屏无事件）
  // → 置失败态显示等待提示（仅 UI 用途；等待链不受影响）。
  // ★ 仅在 temp 通道武装：blob 预览正常的浏览器（Chrome/App 等）有 onError 兜底，
  // 不需要看门狗，避免慢速设备 blob 加载超过 6s 被误判"解码挂起"。
  const clearDecodeWatchdog = usePreviewDecodeWatchdog({
    arm: tempActive && !!effectiveVideoSrc && !previewPanelVisible,
    onTimeout: () => setVideoError(true),
    restartKey: previewRetry,
  });
  // canplay = 解码器真正就绪：解除看门狗、解除转码等待、复位计数、清失败标记
  const handlePreviewReady = () => {
    clearDecodeWatchdog();
    setWaitingTranscode(false);
    resetPreviewAutoRetry();
    setVideoError(false);
  };

  // 封面截帧/解码状态：extractFrame（720p 画布限制/同值 seek 直接截取/2s 超时兜底）、
  // 黑屏判定、时长读取（自 hooks/useVideoCoverCapture 拆出，行为不变；P2 超时定时器已清理）
  const { videoDuration, handleVideoLoaded, handleVideoError, handleCoverTimeChange, handleCoverFileSelect } =
    useVideoCoverCapture({
      videoRef,
      canvasRef,
      videoFile,
      videoCoverPreview,
      setVideoCoverFile,
      setVideoCoverPreview,
      setCoverTime,
      setVideoError,
    });

  const hasContent = images.length > 0 || videoFile !== null;

  // 关闭/放弃/历史条目/返回键/ESC 生命周期（自 hooks/useComposerLifecycle 拆出，行为不变）
  const { closing, showDiscardConfirm, setShowDiscardConfirm, handleClose, handleDiscard, confirmDiscard } =
    useComposerLifecycle({
      hasContent,
      // 确认放弃时的清理：blob 撤销 + 草稿字段复位（resetDraft = 图片 revoke + 清空 + 视频复位）
      onConfirmDiscard: () => {
        resetDraft();
        setDescription('');
        setCurrentImageIndex(0);
        setStep(1);
      },
      closeCreate,
    });

  const handleContinue = () => {
    if (videoFile)
      setStep(2); // 视频跳转封面编辑
    else if (images.length > 0) {
      setCurrentImageIndex(0);
      setStep(3);
    } // 图片跳转描述编辑
  };

  // 换视频时复位预览通道/重试状态（在选择入口同步复位，避免 effect 级联渲染）
  const handleVideoSelectResetting = (e: ChangeEvent<HTMLInputElement>) => {
    setTempActive(false);
    setPreviewRetry(0);
    setTranscoding(false);
    setWaitingTranscode(false);
    resetPreviewAutoRetry();
    handleVideoSelect(e);
  };
  const handleBack = () => {
    if (step === 2)
      setStep(1); // 从封面返回媒体选择
    else if (step === 3) setStep(videoFile ? 2 : 1); // 从描述返回
  };

  const handleSubmit = async () => {
    if (!hasContent || submitting) return;
    // 语音房间优先：上传视频会占用上行带宽，提醒用户可能造成语音卡顿（不阻止发布）
    if (inRoom && videoFile) {
      showToast('当前在语音房间：上传视频会占用带宽，可能造成语音卡顿');
    }
    setSubmitting(true);
    setUploadProgress(0);
    try {
      let newPost: import('../../types').Post | null = null;
      if (videoFile) {
        const isNativeLarge = Capacitor.isNativePlatform() && videoFile.size > 20 * 1024 * 1024;
        // 浏览器环境：选择视频时已后台上传临时文件（预览兜底通道）——
        // 等它落地后直接以 video_url 发布（服务端移动文件进正式目录，不二次上传）。
        // 上传失败/未触发时走原有整文件上传路径，行为不变。
        const pendingUpload = !Capacitor.isNativePlatform() ? waitForTempVideoUpload() : null;
        const landResult = pendingUpload ? await pendingUpload.catch(() => null) : null;
        const tempUrl = landResult?.url ?? tempVideoUrl;
        if (tempUrl) {
          newPost = await createVideoPostFromTempUrl(
            tempUrl,
            videoCoverFile,
            description,
            closeComments,
            pinned
          );
        } else if (isNativeLarge) {
          // 原生大文件走分片上传（5MB/片），避免一次性 300M FormData 全部进内存导致 WebView OOM 闪退
          // 分片阶段占 90% 进度，最后 10% 为服务端转码前完成
          newPost = await createVideoPostChunked(
            videoFile,
            videoCoverFile,
            description,
            closeComments,
            pinned,
            (pct) => setUploadProgress(pct)
          );
        } else {
          const formData = new FormData();
          formData.append('video', videoFile);
          if (videoCoverFile) formData.append('cover', videoCoverFile);
          formData.append('description', description);
          if (closeComments) formData.append('close_comments', '1');
          if (pinned) formData.append('pinned', '1');
          // createVideoPost 使用 timeout: 0（视频上传+服务端转码可能超过全局15s超时，
          // 超时会导致"发布失败"误报，但服务端实际已发布成功）
          newPost = await createVideoPost(formData);
        }
      } else {
        const formData = new FormData();
        // 按拖拽后的顺序上传（B2 修复：所见即所得）
        images.forEach((img) => formData.append('images', img.file));
        formData.append('description', description);
        if (closeComments) formData.append('close_comments', '1');
        if (pinned) formData.append('pinned', '1');
        newPost = await createImagePost(formData);
      }
      showToast('分享成功！');
      // 立即写入信息流缓存，首页无需等待 refetch 即可实时出现
      if (newPost) {
        updatePostsFeed(queryClient, (prev) => [newPost!, ...prev.filter((p) => p.id !== newPost!.id)]);
        events.emit('post:created', newPost);
      } else {
        events.emit('post:created');
      }
      // 发布成功后回收大文件 Blob URL，释放内存
      handleRemoveVideo();
      handleClose();
    } catch (err) {
      const msg = getApiErrorMessage(err, '发布失败');
      // 分片失败时提示已上传进度，便于重试
      if (uploadProgress > 0 && uploadProgress < 100) {
        showToast(`${msg}（已传 ${uploadProgress}%）`);
      } else {
        showToast(msg);
      }
    } finally {
      setSubmitting(false);
      setUploadProgress(0);
    }
  };

  // 步骤 1: 选择媒体（视图见 MediaPickerStep；状态与 handler 全部下传）
  if (step === 1) {
    return (
      <MediaPickerStep
        images={images}
        setImages={setImages}
        hasContent={hasContent}
        closing={closing}
        fileInputRef={fileInputRef}
        videoInputRef={videoInputRef}
        onFileSelect={handleFileSelect}
        onVideoSelect={handleVideoSelectResetting}
        onRemoveImage={handleRemoveImage}
        onDiscard={handleDiscard}
        onContinue={handleContinue}
        showDiscardConfirm={showDiscardConfirm}
        onDiscardConfirm={confirmDiscard}
        onDiscardCancel={() => setShowDiscardConfirm(false)}
      />
    );
  }

  // 步骤 2: 视频封面编辑（视图见 VideoCoverEditor；截帧/解码状态自 useVideoCoverCapture）
  if (step === 2 && videoFile) {
    return (
      <VideoCoverEditor
        closing={closing}
        videoFile={videoFile}
        videoPreview={effectiveVideoSrc}
        videoError={previewPanelVisible}
        videoCoverPreview={videoCoverPreview}
        videoDuration={videoDuration}
        coverTime={coverTime}
        videoRef={videoRef}
        canvasRef={canvasRef}
        coverInputRef={coverInputRef}
        onVideoLoaded={handleVideoLoaded}
        onVideoError={handleVideoPreviewError}
        onPreviewReady={handlePreviewReady}
        onCoverTimeChange={handleCoverTimeChange}
        onCoverFileSelect={handleCoverFileSelect}
        previewReloadKey={previewRetry}
        previewSwitching={tempVideoUploading || transcoding}
        showRetryButton={!(tempVideoUploading || transcoding)}
        onRetryPreview={() => {
          // 重试：先 revoke 再重建 blob（blob 通道），并递增重试计数强制
          // video 重新挂载（temp HTTP 通道同样生效），强制 WebView 重载。
          // 同时重新进入转码等待态：若重试时转码未完成/仍失败，
          // 等待链继续轮询直至转码完成自动恢复（不再依赖失败事件重启）。
          if (videoFile) {
            try {
              if (videoPreview) URL.revokeObjectURL(videoPreview);
            } catch {}
            const url = URL.createObjectURL(videoFile);
            setVideoPreview(url);
            setVideoError(false);
            setWaitingTranscode(true);
            setPreviewRetry((n) => n + 1);
          }
        }}
        onBack={handleBack}
        onNext={() => setStep(3)}
        showDiscardConfirm={showDiscardConfirm}
        onDiscardConfirm={confirmDiscard}
        onDiscardCancel={() => setShowDiscardConfirm(false)}
      />
    );
  }

  // 步骤 3: 编辑分享
  return (
    <div className={`${composer.overlay}${closing ? ` ${composer.closing}` : ''}`}>
      <div className={`${composer.dialog}${closing ? ` ${composer.closing}` : ''}`}>
        <div className={composer.overlayHeader}>
          <button className={composer.overlayBtn} data-back onClick={handleBack}>
            后退
          </button>
          <span className={composer.overlayTitle}>编辑</span>
          <button
            className={`${composer.overlayBtn} ${composer.primary}`}
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting ? (uploadProgress > 0 ? `上传中 ${uploadProgress}%` : '发布中...') : '分享'}
          </button>
        </div>
        <div className={composer.editLayout}>
          <div className={composer.editLeft}>
            <div className={composer.editImageWrapper}>
              {effectiveVideoSrc && !previewPanelVisible ? (
                <video
                  key={`${effectiveVideoSrc}|${previewRetry}`}
                  src={effectiveVideoSrc}
                  controls
                  className={composer.editVideo}
                  preload="metadata"
                  playsInline
                  muted
                  onLoadedMetadata={() => {
                    // 元数据就绪（可播放或黑屏判定由其后的 useVideoCoverCapture 负责）：
                    // 复位自动重试计数 + 清失败标记
                    resetPreviewAutoRetry();
                    setVideoError(false);
                  }}
                  onCanPlay={handlePreviewReady}
                  onError={handleVideoPreviewError}
                  poster={videoCoverPreview || undefined}
                  style={{ background: '#000' }}
                />
              ) : videoFile ? (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: '#1a1a1a',
                    color: '#ccc',
                    height: 200,
                    fontSize: 13,
                    padding: 12,
                    textAlign: 'center',
                    gap: 8,
                  }}
                >
                  <Video size={28} style={{ opacity: 0.6 }} />
                  <div>
                    {videoFile.name} ({(videoFile.size / 1024 / 1024).toFixed(1)}MB)
                  </div>
                  {videoError ? (
                    <div style={{ fontSize: 12, color: '#ffb74d' }}>
                      {tempVideoUploading || transcoding
                        ? '视频转码中（约需 1 分钟内），完成后自动显示预览…'
                        : '视频预览暂不可用（HEVC/编码限制），不影响发布'}
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, opacity: 0.8 }}>预览已简化，封面可正常显示</div>
                  )}
                  {videoCoverPreview && (
                    <img
                      src={videoCoverPreview}
                      alt="封面"
                      style={{ maxWidth: '100%', maxHeight: 100, borderRadius: 6, marginTop: 8 }}
                    />
                  )}
                </div>
              ) : (
                <>
                  <img
                    src={images[currentImageIndex]?.url ?? images[0]?.url}
                    alt=""
                    className={composer.editImage}
                    onError={(e) => {
                      e.currentTarget.onerror = null;
                      e.currentTarget.src = IMAGE_PREVIEW_FALLBACK;
                    }}
                  />
                  {images.length > 1 && (
                    <>
                      {currentImageIndex > 0 && (
                        <button
                          className={`${composer.editNav} ${composer.editPrev}`}
                          onClick={() => setCurrentImageIndex((prev) => prev - 1)}
                          aria-label="上一张"
                        >
                          ‹
                        </button>
                      )}
                      {currentImageIndex < images.length - 1 && (
                        <button
                          className={`${composer.editNav} ${composer.editNext}`}
                          onClick={() => setCurrentImageIndex((prev) => prev + 1)}
                          aria-label="下一张"
                        >
                          ›
                        </button>
                      )}
                      <div className={composer.editDots}>
                        {images.map((_, i) => (
                          <span
                            key={i}
                            className={`${composer.editDot} ${i === currentImageIndex ? composer.active : ''}`}
                            onClick={() => setCurrentImageIndex(i)}
                          />
                        ))}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
          <PostDescriptionPanel
            user={user}
            description={description}
            onChange={setDescription}
            onEmoji={(emoji) => setDescription((prev) => prev + emoji)}
            textareaRef={textareaRef}
            showAdvanced={showAdvanced}
            onToggleAdvanced={() => setShowAdvanced((v) => !v)}
            closeComments={closeComments}
            onCloseCommentsChange={setCloseComments}
            pinned={pinned}
            onPinnedChange={setPinned}
          />
        </div>
      </div>
    </div>
  );
}
