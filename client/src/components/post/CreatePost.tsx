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
 * ============================================================
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { ImagePlus, Video, X } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { useQueryClient } from '@tanstack/react-query';
import ConfirmDialog from '../ui/ConfirmDialog';
import VideoCoverEditor from './VideoCoverEditor';
import PostDescriptionPanel from './PostDescriptionPanel';
import { useAuth } from '../../context/AuthContext';
import { useVoiceInRoom } from '../../context/VoiceContext';
import { useEvent } from '../../context/CreateContext';
import { events } from '../../state/events';
import { updatePostsFeed } from '../../hooks/usePostsFeed';
import { showToast } from '../ui/Toast';
import { useImageGridDrag } from '../../hooks/useImageGridDrag';
import { createImagePost, createVideoPost, createVideoPostChunked } from '../../api/posts';
import { IMAGE_PREVIEW_FALLBACK, fileToPreviewUrl } from '../../utils';
import styles from './CreatePost.module.css';
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
  // 供卸载时兜底回收图片预览 blob URL（避免 effect 依赖重建导致误 revoke 正在显示的图）
  const imagePreviewsRef = useRef<string[]>([]);

  // 统一的图片项：{ url, isNew, file }。B2 修复——拖拽重排这一个数组，
  // 上传时按其遍历，保证"所见即所得"（此前 imageFiles/imagePreviews 两个
  // 平行数组导致拖拽排序不反映在实际上传顺序）。
  interface ImageItem {
    url: string;
    file: File;
  }

  // 步骤: 1 = 选择媒体, 2 = 视频封面, 3 = 编辑分享
  const [step, setStep] = useState(1);
  const [images, setImages] = useState<ImageItem[]>([]);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoPreview, setVideoPreview] = useState<string | null>(null);
  const [videoCoverFile, setVideoCoverFile] = useState<File | null>(null);
  const [videoCoverPreview, setVideoCoverPreview] = useState<string | null>(null);
  const [videoDuration, setVideoDuration] = useState(0);
  const [coverTime, setCoverTime] = useState(0);
  const [videoError, setVideoError] = useState(false);
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [closeComments, setCloseComments] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const [closing, setClosing] = useState(false);
  const [currentImageIndex, setCurrentImageIndex] = useState(0);

  // 图片拖拽排序（按下即拖，实时重排；重置统一数组，拖拽=上传顺序）
  const { dragIndex, gridRefs, handlers: dragHandlers } = useImageGridDrag(setImages);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const remaining = 9 - images.length;
    const toAdd = files.slice(0, remaining);
    if (toAdd.length === 0) return;

    // 检查文件大小 (10MB)
    const maxSize = 10 * 1024 * 1024;
    const validFiles = toAdd.filter((file) => {
      if (file.size > maxSize) {
        showToast(`"${file.name}" 超过10MB限制`);
        return false;
      }
      return true;
    });

    if (validFiles.length === 0) return;

    // 选择照片时清除视频状态
    if (videoFile) {
      handleRemoveVideo();
    }

    // 本地预览：HEIC/HEIF 经 WASM 实时转 JPEG，其余格式直接 blob URL（保持选择顺序）
    Promise.all(validFiles.map((f) => fileToPreviewUrl(f))).then((urls) => {
      setImages((prev) => [...prev, ...urls.map((url, i) => ({ url, file: validFiles[i] }))]);
    });
    e.target.value = '';
  };

  const handleRemoveImage = (index: number) => {
    const removed = images[index];
    if (removed && removed.url.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(removed.url);
      } catch {}
    }
    setImages((prev) => prev.filter((_, i) => i !== index));
  };

  const handleVideoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // 检查视频大小 (300MB)
    const maxSize = 300 * 1024 * 1024;
    if (file.size > maxSize) {
      const sizeMB = (file.size / 1024 / 1024).toFixed(1);
      showToast(`视频大小 ${sizeMB}MB，超过300MB限制`);
      e.target.value = '';
      return;
    }

    // Android WebView 提示：大文件仅影响自动截帧，预览仍尝试（metadata 模式不占大内存）
    const isNative = Capacitor.isNativePlatform();
    if (isNative && file.size > 150 * 1024 * 1024) {
      showToast(`视频较大(${(file.size / 1024 / 1024).toFixed(0)}MB)，将使用分片上传，预览可能较慢`);
    }

    // 选择视频时清除照片状态
    if (images.length > 0) {
      images.forEach((u) => {
        if (u.url.startsWith('blob:')) {
          try {
            URL.revokeObjectURL(u.url);
          } catch {}
        }
      });
      setImages([]);
    }

    try {
      // 清理旧 URL 防止泄漏
      if (videoPreview) {
        try {
          URL.revokeObjectURL(videoPreview);
        } catch {}
      }
      if (videoCoverPreview) {
        try {
          URL.revokeObjectURL(videoCoverPreview);
        } catch {}
      }
      setVideoFile(file);
      const url = URL.createObjectURL(file);
      setVideoPreview(url);
      setVideoCoverFile(null);
      setVideoCoverPreview(null);
      setCoverTime(0);
      setVideoError(false);
      setStep(2); // 自动跳转到封面编辑
    } catch (err) {
      console.error('视频预览创建失败', err);
      showToast('视频预览失败，请重试或选择更小的文件');
      // 仍保留 file 以便尝试直接发布（不依赖预览）
      setVideoFile(file);
      setVideoPreview(null);
      setVideoError(true);
      setStep(2);
    } finally {
      e.target.value = '';
    }
  };

  const handleRemoveVideo = () => {
    try {
      if (videoPreview) URL.revokeObjectURL(videoPreview);
    } catch {}
    try {
      if (videoCoverPreview) URL.revokeObjectURL(videoCoverPreview);
    } catch {}
    setVideoFile(null);
    setVideoPreview(null);
    setVideoCoverFile(null);
    setVideoCoverPreview(null);
    setCoverTime(0);
    setVideoError(false);
  };

  // 组件卸载 / 预览变更时自动回收 Blob URL，防止大文件常驻内存导致 OOM
  useEffect(() => {
    imagePreviewsRef.current = images.map((img) => img.url);
    return () => {
      try {
        if (videoPreview) URL.revokeObjectURL(videoPreview);
      } catch {}
      try {
        if (videoCoverPreview) URL.revokeObjectURL(videoCoverPreview);
      } catch {}
      imagePreviewsRef.current.forEach((u) => {
        if (u.startsWith('blob:')) {
          try {
            URL.revokeObjectURL(u);
          } catch {}
        }
      });
    };
  }, [videoPreview, videoCoverPreview, images]);

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
      const orig = capture;
      video.onseeked = () => {
        window.clearTimeout(t);
        orig();
      };
      video.currentTime = time;
    } catch (e) {
      console.error('video seek 失败', e);
    }
  };

  const handleCoverTimeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    setCoverTime(time);
    extractFrame(time);
  };

  const handleCoverFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
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
      // 仅在视频可解码且非超大文件时自动截帧；超大文件跳过以防 OOM，依赖服务端兜底
      const isLarge = (videoFile?.size || 0) > 150 * 1024 * 1024;
      if (!isLarge) {
        extractFrame(0);
      } else {
        console.log('跳过自动截帧（超大文件），由服务端兜底');
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

  const hasContent = images.length > 0 || videoFile !== null;

  const handleClose = useCallback(() => {
    setClosing(true);
    setTimeout(() => {
      closeCreate();
    }, 200);
  }, [closeCreate]);

  const handleDiscard = useCallback(() => {
    if (hasContent) {
      setShowDiscardConfirm(true);
    } else handleClose();
  }, [hasContent, handleClose]);

  const confirmDiscard = () => {
    images.forEach((u) => {
      if (u.url.startsWith('blob:')) {
        try {
          URL.revokeObjectURL(u.url);
        } catch {}
      }
    });
    setImages([]);
    handleRemoveVideo();
    setDescription('');
    setCurrentImageIndex(0);
    setStep(1);
    setShowDiscardConfirm(false);
    handleClose();
  };

  // 打开时推入历史记录，让返回键可以触发放弃操作
  useEffect(() => {
    window.history.pushState(null, '', window.location.href);
  }, []);

  // Android 返回键：触发放弃操作
  // 使用 capture phase + stopPropagation 阻止 HomePage 的 popstate 处理器
  useEffect(() => {
    const handlePopState = (e: PopStateEvent) => {
      e.stopPropagation(); // 阻止 HomePage 的 capture handler
      if (showDiscardConfirm) {
        setShowDiscardConfirm(false);
      } else {
        handleDiscard();
      }
    };
    window.addEventListener('popstate', handlePopState, true); // capture phase
    return () => window.removeEventListener('popstate', handlePopState, true);
  }, [showDiscardConfirm, hasContent, handleDiscard]);

  // ESC 键关闭（有内容时弹出放弃确认）
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showDiscardConfirm) {
          setShowDiscardConfirm(false);
        } else {
          handleDiscard();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [showDiscardConfirm, hasContent, handleDiscard]);

  const handleContinue = () => {
    if (videoFile)
      setStep(2); // 视频跳转封面编辑
    else if (images.length > 0) {
      setCurrentImageIndex(0);
      setStep(3);
    } // 图片跳转描述编辑
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
        if (isNativeLarge) {
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
    } catch (err: any) {
      const msg = err.response?.data?.error || err.message || '发布失败';
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

  const renderGrid = () => {
    return (
      <div className={composer.gridWrapper}>
        <div className={composer.grid}>
          {images.map((img, i) => (
            <div
              key={`${img.url}-${i}`}
              ref={(el) => {
                gridRefs.current[i] = el;
              }}
              className={[composer.gridItem, i === dragIndex ? composer.dragging || '' : '']
                .filter(Boolean)
                .join(' ')}
              onPointerDown={(e) => dragHandlers.onPointerDown(e, i)}
            >
              <img
                src={img.url}
                alt={`图片 ${i + 1}`}
                draggable={false}
                onError={(e) => {
                  e.currentTarget.onerror = null;
                  e.currentTarget.src = IMAGE_PREVIEW_FALLBACK;
                }}
              />
              <span className={composer.gridIndex}>{i + 1}</span>
              <button
                className={composer.gridDeleteBtn}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  handleRemoveImage(i);
                }}
              >
                <X size={14} />
              </button>
            </div>
          ))}
          {images.length < 9 && (
            <div className={composer.gridAdd} onClick={() => fileInputRef.current?.click()}>
              <ImagePlus size={28} />
            </div>
          )}
        </div>
      </div>
    );
  };

  // 步骤 1: 选择媒体
  if (step === 1) {
    return (
      <div
        className={`${composer.overlay}${closing ? ` ${composer.closing}` : ''}`}
        onPointerMove={dragHandlers.onPointerMove}
        onPointerUp={dragHandlers.onPointerUp}
        onPointerCancel={dragHandlers.onPointerCancel}
      >
        <div className={`${composer.dialog}${closing ? ` ${composer.closing}` : ''}`}>
          <div className={composer.overlayHeader}>
            <button className={`${composer.overlayBtn} ${composer.danger}`} data-back onClick={handleDiscard}>
              放弃
            </button>
            <span className={composer.overlayTitle}>选择照片/视频</span>
            <button
              className={`${composer.overlayBtn} ${composer.primary}`}
              onClick={handleContinue}
              disabled={!hasContent}
            >
              继续
            </button>
          </div>
          <div className={composer.overlayBody}>
            {images.length > 0 ? (
              renderGrid()
            ) : (
              <div className={styles.uploadArea}>
                <div className={styles.uploadBtns}>
                  <button className={styles.uploadBtn} onClick={() => fileInputRef.current?.click()}>
                    <ImagePlus size={20} />
                    选择照片
                  </button>
                  <button className={styles.uploadBtn} onClick={() => videoInputRef.current?.click()}>
                    <Video size={20} />
                    选择视频
                  </button>
                </div>
                <div className={styles.uploadHint}>照片最多9张，支持 HEIC/HEIF，视频支持 mp4、mov</div>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/jpg,image/png,image/gif,image/webp,image/avif,image/heic,image/heif"
              multiple
              style={{ display: 'none' }}
              onChange={handleFileSelect}
            />
            <input
              ref={videoInputRef}
              type="file"
              accept="video/mp4,video/quicktime"
              style={{ display: 'none' }}
              onChange={handleVideoSelect}
            />
          </div>
        </div>

        {showDiscardConfirm && (
          <ConfirmDialog
            message="确定要放弃此次分享吗？"
            onConfirm={confirmDiscard}
            onCancel={() => setShowDiscardConfirm(false)}
          />
        )}
      </div>
    );
  }

  // 步骤 2: 视频封面编辑（视图见 VideoCoverEditor；截帧/解码状态留在本组件）
  if (step === 2 && videoFile) {
    return (
      <VideoCoverEditor
        closing={closing}
        videoFile={videoFile}
        videoPreview={videoPreview}
        videoError={videoError}
        videoCoverPreview={videoCoverPreview}
        videoDuration={videoDuration}
        coverTime={coverTime}
        videoRef={videoRef}
        canvasRef={canvasRef}
        coverInputRef={coverInputRef}
        onVideoLoaded={handleVideoLoaded}
        onVideoError={handleVideoError}
        onCoverTimeChange={handleCoverTimeChange}
        onCoverFileSelect={handleCoverFileSelect}
        onRetryPreview={() => {
          // 重试：先 revoke 再重建 blob，强制 WebView 重载
          if (videoFile) {
            try {
              if (videoPreview) URL.revokeObjectURL(videoPreview);
            } catch {}
            const url = URL.createObjectURL(videoFile);
            setVideoPreview(url);
            setVideoError(false);
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
              {videoPreview && !videoError ? (
                <video
                  key={videoPreview}
                  src={videoPreview}
                  controls
                  className={composer.editVideo}
                  preload="metadata"
                  playsInline
                  muted
                  onLoadedMetadata={() => setVideoError(false)}
                  onError={handleVideoError}
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
                      视频预览暂不可用（HEVC/编码限制），不影响发布
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
