/**
 * ============================================================
 * 私密文件夹状态机 Hook（usePrivateFolder）
 * ============================================================
 * 自 client/src/components/profile/Profile.tsx 拆出（纯搬移，行为不变）。
 *
 * 私密文件夹（最多 10 张私密图片）的全部状态与行为：
 * - objectURL 生命周期：新增文件经 fileToPreviewUrl 生成 blob 预览
 *   （HEIC/HEIF 走 WASM 实时转 JPEG），删除单个新文件 / 取消弹窗时
 *   逐个 URL.revokeObjectURL，避免内存泄漏
 * - 保存串行：先逐张删除标记图片，再逐张上传新图片，最后刷新列表并关弹窗
 * - 计数语义：visibleCount = 未删除存量 + 新增文件，剩余名额不足时截断
 *   （toAdd.length === 0 直接返回，不清空 input）
 * - 打开弹窗时重置 privateDeletedIds / privateNewFiles
 *
 * toast 文案与错误处理路径与 Profile 原版逐字节一致。
 * ============================================================
 */

import { useRef, useState } from 'react';
import type { ChangeEvent, Dispatch, RefObject, SetStateAction } from 'react';
import api from '../api/http';
import { getApiErrorMessage } from '../api/http';
import { fileToPreviewUrl } from '../utils';
import { showToast } from '../components/ui/Toast';
import type {
  PrivateImageItem,
  PrivateNewFileItem,
  PrivateZoomItem,
} from '../components/profile/PrivateFolder';

export interface UsePrivateFolderResult {
  showPrivateFolder: boolean;
  privateImages: PrivateImageItem[];
  privateNewFiles: PrivateNewFileItem[];
  privateDeletedIds: Set<number>;
  privateZoomIndex: number | null;
  setPrivateZoomIndex: Dispatch<SetStateAction<number | null>>;
  privateFileInputRef: RefObject<HTMLInputElement | null>;
  handleOpenPrivateFolder: () => Promise<void>;
  handleAddPrivateImages: (e: ChangeEvent<HTMLInputElement>) => Promise<void>;
  handleRemovePrivateNewFile: (index: number) => void;
  handleToggleDeletePrivate: (id: number) => void;
  handleSavePrivateFolder: () => Promise<void>;
  handleCancelPrivateFolder: () => void;
  /** 展示/缩放用合并列表（存量在前、新增在后，每次渲染重新计算） */
  getAllPrivateImages: () => PrivateZoomItem[];
}

export function usePrivateFolder(): UsePrivateFolderResult {
  const [showPrivateFolder, setShowPrivateFolder] = useState(false);
  const [privateImages, setPrivateImages] = useState<PrivateImageItem[]>([]);
  const [privateNewFiles, setPrivateNewFiles] = useState<PrivateNewFileItem[]>([]);
  const [privateDeletedIds, setPrivateDeletedIds] = useState<Set<number>>(new Set());
  const [privateZoomIndex, setPrivateZoomIndex] = useState<number | null>(null);
  const privateFileInputRef = useRef<HTMLInputElement>(null);

  const handleOpenPrivateFolder = async () => {
    setShowPrivateFolder(true);
    setPrivateDeletedIds(new Set());
    setPrivateNewFiles([]);
    try {
      const res = await api.get('/users/me/private-images');
      setPrivateImages(res.data.images);
    } catch {
      showToast('私密图片加载失败');
    }
  };

  const handleAddPrivateImages = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const visibleCount =
      privateImages.filter((img) => !privateDeletedIds.has(img.id)).length + privateNewFiles.length;
    const remaining = 10 - visibleCount;
    const toAdd = files.slice(0, remaining);
    if (toAdd.length === 0) return;
    // HEIC/HEIF 经 WASM 实时转 JPEG 预览，其余格式直接 blob URL
    const newItems = await Promise.all(
      toAdd.map(async (file) => ({ file, preview: await fileToPreviewUrl(file) }))
    );
    setPrivateNewFiles((prev) => [...prev, ...newItems]);
    e.target.value = '';
  };

  const handleRemovePrivateNewFile = (index: number) => {
    setPrivateNewFiles((prev) => {
      const f = prev[index];
      if (f) URL.revokeObjectURL(f.preview);
      return prev.filter((_, i) => i !== index);
    });
  };

  const handleToggleDeletePrivate = (id: number) => {
    setPrivateDeletedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSavePrivateFolder = async () => {
    let failed = false;
    // 任一步失败：toast 提示后继续执行剩余删除/上传项，
    // 最后无论如何都重新拉取列表，使 UI 收敛到服务端真实状态（§5.2）
    for (const id of privateDeletedIds) {
      try {
        await api.delete(`/users/me/private-images/${id}`);
      } catch (err) {
        failed = true;
        showToast(getApiErrorMessage(err, '保存失败'));
      }
    }
    for (const item of privateNewFiles) {
      try {
        const formData = new FormData();
        formData.append('image', item.file);
        await api.post('/users/me/private-images', formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });
      } catch (err) {
        failed = true;
        showToast(getApiErrorMessage(err, '保存失败'));
      }
    }
    // Refresh（无论成败都执行）
    try {
      const res = await api.get('/users/me/private-images');
      setPrivateImages(res.data.images);
    } catch (err) {
      failed = true;
      showToast(getApiErrorMessage(err, '保存失败'));
    }
    setPrivateNewFiles([]);
    setPrivateDeletedIds(new Set());
    if (failed) return; // 保留弹窗，展示已收敛的服务端真实状态，用户可调整后重试
    setShowPrivateFolder(false);
    showToast('保存成功！');
  };

  const handleCancelPrivateFolder = () => {
    privateNewFiles.forEach((item) => URL.revokeObjectURL(item.preview));
    setPrivateNewFiles([]);
    setPrivateDeletedIds(new Set());
    setShowPrivateFolder(false);
  };

  const getAllPrivateImages = (): PrivateZoomItem[] => {
    const existing = privateImages
      .filter((img) => !privateDeletedIds.has(img.id))
      .map((img) => ({ type: 'existing' as const, url: img.image_url, id: img.id }));
    const newOnes = privateNewFiles.map((item, i) => ({ type: 'new' as const, url: item.preview, index: i }));
    return [...existing, ...newOnes];
  };

  return {
    showPrivateFolder,
    privateImages,
    privateNewFiles,
    privateDeletedIds,
    privateZoomIndex,
    setPrivateZoomIndex,
    privateFileInputRef,
    handleOpenPrivateFolder,
    handleAddPrivateImages,
    handleRemovePrivateNewFile,
    handleToggleDeletePrivate,
    handleSavePrivateFolder,
    handleCancelPrivateFolder,
    getAllPrivateImages,
  };
}
