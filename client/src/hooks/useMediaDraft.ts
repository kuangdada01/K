/**
 * ============================================================
 * 媒体草稿 Hook（hooks/useMediaDraft）
 * ============================================================
 * 自 CreatePost.tsx 拆出（行为逐字节不变）：
 * - 图片统一数组 images（拖拽排序即上传顺序）；9 张上限（P1：functional updater
 *   内 slice(0,9)，快速连续选择不突破上限）、10MB 校验、HEIC/HEIF 经
 *   fileToPreviewUrl 实时转 JPEG 预览（失败回退占位图）、选图时清除视频状态
 * - 视频选择：300MB 上限、原生 WebView 大文件提示、blob URL 创建、
 *   选视频时清除图片状态（逐个 revoke）
 * - blob 生命周期：删除/替换/清空时 revoke；卸载兜底 revoke 经 ref 镜像
 *   （cleanup 依赖为空，从 ref 读最新值，增删/排序过程中绝不提前 revoke；
 *   严格模式双挂载安全）
 * - coverTime / videoError 随视频草稿生命周期复位（供封面截帧 hook 联动）
 *
 * 两个消费方：
 * - CreatePost：makeItem=(url,file)=>({url,file})，shouldRevoke=默认 blob: 前缀；
 *   onVideoSelected 用于选择视频后跳转封面步骤（对应原 setStep(2)）
 * - EditPost：makeItem=(url,file)=>({url,isNew:true,file})，
 *   shouldRevoke=item.isNew（仅新增条目 revoke，已有图片不 revoke）
 */

import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, Dispatch, SetStateAction } from 'react';
import { Capacitor } from '@capacitor/core';
import { showToast } from '../components/ui/Toast';
import { fileToPreviewUrl } from '../utils';

/** 媒体条目最小形状：url 必须；CreatePost 条目 {url,file}，EditPost 条目 {url,isNew,file?} */
export interface MediaDraftItem {
  url: string;
  file?: File;
  isNew?: boolean;
}

export interface UseMediaDraftOptions<T extends { url: string }> {
  /** 新图片条目构造器；默认 (url,file)=>({url,file}) */
  makeItem?: (url: string, file: File) => T;
  /** 删除条目时是否 revoke 其 URL；默认 blob: 前缀（CreatePost 语义），
   *  EditPost 传 item.isNew（仅新增条目 revoke，已有图片不 revoke） */
  shouldRevoke?: (item: T) => boolean;
  /** 视频选择成功/失败路径都会调用（CreatePost 用于 setStep(2) 跳转封面步骤）；
   *  EditPost 无视频功能，不传 */
  onVideoSelected?: () => void;
}

export interface UseMediaDraftResult<T extends { url: string }> {
  images: T[];
  setImages: Dispatch<SetStateAction<T[]>>;
  videoFile: File | null;
  videoPreview: string | null;
  setVideoPreview: Dispatch<SetStateAction<string | null>>;
  videoCoverFile: File | null;
  setVideoCoverFile: Dispatch<SetStateAction<File | null>>;
  videoCoverPreview: string | null;
  setVideoCoverPreview: Dispatch<SetStateAction<string | null>>;
  /** 封面截帧滑动时间（随视频选择/移除复位；供 useVideoCoverCapture 联动） */
  coverTime: number;
  setCoverTime: Dispatch<SetStateAction<number>>;
  /** 视频解码/预览错误标记（随视频选择/移除复位；供 useVideoCoverCapture 联动） */
  videoError: boolean;
  setVideoError: Dispatch<SetStateAction<boolean>>;
  /** 图片选择（9 张截断 + 10MB 校验 + HEIC 预览；CreatePost/EditPost 共用） */
  handleFileSelect: (e: ChangeEvent<HTMLInputElement>) => void;
  /** 移除图片：revoke（blob: 或 isNew 谓词命中）后从数组剔除 */
  handleRemoveImage: (index: number) => void;
  /** 视频选择（300MB 上限、原生/网页路径、blob URL、清图片；成功后调 onVideoSelected） */
  handleVideoSelect: (e: ChangeEvent<HTMLInputElement>) => void;
  /** 移除视频：revoke 视频预览 + 封面预览，复位全部视频/封面/解码状态 */
  handleRemoveVideo: () => void;
  /** 放弃草稿：revoke 全部图片 blob + 清空图片 + handleRemoveVideo
   *  （对应原 onConfirmDiscard 的清理前三步） */
  resetDraft: () => void;
}

export function useMediaDraft<T extends { url: string }>(
  options?: UseMediaDraftOptions<T>
): UseMediaDraftResult<T> {
  const { makeItem, shouldRevoke, onVideoSelected } = options ?? {};

  const [images, setImages] = useState<T[]>([]);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoPreview, setVideoPreview] = useState<string | null>(null);
  const [videoCoverFile, setVideoCoverFile] = useState<File | null>(null);
  const [videoCoverPreview, setVideoCoverPreview] = useState<string | null>(null);
  const [coverTime, setCoverTime] = useState(0);
  const [videoError, setVideoError] = useState(false);

  // 统一的图片项构造与删除谓词（按调用方语义注入；默认 CreatePost 语义）
  const buildItem: (url: string, file: File) => T =
    makeItem ?? ((url: string, file: File) => ({ url, file }) as unknown as T);
  const revokeItem: (item: T) => boolean = shouldRevoke ?? ((item: T) => item.url.startsWith('blob:'));

  // 卸载兜底专用镜像 ref：cleanup 依赖为空，从 ref 读最新值，增删/排序过程中绝不提前 revoke
  // （旧实现把 images/videoPreview 放进依赖，cleanup 每次变化都 revoke 全部预览，
  //  拖拽排序后 <img> 用已 revoke 的 URL 重载 → 全部变成 HEIC 占位图）
  const imagePreviewsRef = useRef<string[]>([]);
  const videoPreviewRef = useRef<string | null>(null);
  const videoCoverPreviewRef = useRef<string | null>(null);
  useEffect(() => {
    videoPreviewRef.current = videoPreview;
    videoCoverPreviewRef.current = videoCoverPreview;
  }, [videoPreview, videoCoverPreview]);
  useEffect(() => {
    imagePreviewsRef.current = images.map((img) => img.url);
  }, [images]);

  const handleFileSelect = (e: ChangeEvent<HTMLInputElement>) => {
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
      // P1 修复：截断放进 functional updater——remaining 基于闭包旧值，
      // 快速连续选择时无条件追加会突破 9 张上限（服务端 multer 会直接 400）
      setImages((prev) => [...prev, ...urls.map((url, i) => buildItem(url, validFiles[i]!))].slice(0, 9));
    });
    e.target.value = '';
  };

  const handleRemoveImage = (index: number) => {
    // revoke 放进 functional updater：以最新 prev[index] 为准
    // （与原 CreatePost 事件闭包内 revoke 语义等价——同一事件内数组不会变化）
    setImages((prev) => {
      const item = prev[index];
      if (item && revokeItem(item)) {
        try {
          URL.revokeObjectURL(item.url);
        } catch {}
      }
      return prev.filter((_, i) => i !== index);
    });
  };

  const handleVideoSelect = (e: ChangeEvent<HTMLInputElement>) => {
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
      onVideoSelected?.(); // 自动跳转到封面编辑（对应原 setStep(2)）
    } catch (err) {
      console.error('视频预览创建失败', err);
      showToast('视频预览失败，请重试或选择更小的文件');
      // 仍保留 file 以便尝试直接发布（不依赖预览）
      setVideoFile(file);
      setVideoPreview(null);
      setVideoError(true);
      onVideoSelected?.();
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

  const resetDraft = () => {
    images.forEach((u) => {
      if (u.url.startsWith('blob:')) {
        try {
          URL.revokeObjectURL(u.url);
        } catch {}
      }
    });
    setImages([]);
    handleRemoveVideo();
  };

  // 组件卸载时统一回收 Blob URL，防止大文件常驻内存导致 OOM
  useEffect(() => {
    return () => {
      try {
        const vp = videoPreviewRef.current;
        if (vp) URL.revokeObjectURL(vp);
      } catch {}
      try {
        const vcp = videoCoverPreviewRef.current;
        if (vcp) URL.revokeObjectURL(vcp);
      } catch {}
      imagePreviewsRef.current.forEach((u) => {
        if (u.startsWith('blob:')) {
          try {
            URL.revokeObjectURL(u);
          } catch {}
        }
      });
    };
    // 卸载兜底：仅挂载/卸载各执行一次，经 ref 读最新值
  }, []);

  return {
    images,
    setImages,
    videoFile,
    videoPreview,
    setVideoPreview,
    videoCoverFile,
    setVideoCoverFile,
    videoCoverPreview,
    setVideoCoverPreview,
    coverTime,
    setCoverTime,
    videoError,
    setVideoError,
    handleFileSelect,
    handleRemoveImage,
    handleVideoSelect,
    handleRemoveVideo,
    resetDraft,
  };
}
