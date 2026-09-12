/**
 * ============================================================
 * 私密文件夹 (PrivateFolder)
 * ============================================================
 * 个人主页的私密图片管理弹窗 + 缩放查看（纯展示组件，
 * 数据与行为回调由 Profile 提供）。
 */

import { RefObject, useEffect, useRef } from 'react';
import { X, ImagePlus, ChevronLeft, ChevronRight } from 'lucide-react';
import { resolveMediaUrl } from '../../utils';
import { useAuthMediaUrl } from '../../hooks/useAuthMediaUrl';
import { useImagePinchZoom } from '../../hooks/useImagePinchZoom';
import { useCancelableClose } from '../../hooks/useCancelableClose';
import { authHeadersFor, openNativeViewer, rectOf } from '../../lib/nativeImageViewer';
import media from '../post/PostMedia.module.css';
import styles from './PrivateFolder.module.css';

export interface PrivateImageItem {
  id: number;
  image_url: string;
}

export interface PrivateNewFileItem {
  file: File;
  preview: string;
}

export type PrivateZoomItem =
  { type: 'existing'; url: string; id: number } | { type: 'new'; url: string; index: number };

/** 鉴权图片（/api/ URL 需带 token 拉 blob；新上传的 blob: 预览直接展示） */
function AuthImg({ url, ...rest }: { url: string } & React.ImgHTMLAttributes<HTMLImageElement>) {
  const src = useAuthMediaUrl(url);
  if (!src) return null;
  return <img src={src} {...rest} />;
}

interface PrivateFolderProps {
  privateImages: PrivateImageItem[];
  privateNewFiles: PrivateNewFileItem[];
  privateDeletedIds: Set<number>;
  allImages: PrivateZoomItem[];
  privateZoomIndex: number | null;
  setPrivateZoomIndex: React.Dispatch<React.SetStateAction<number | null>>;
  privateFileInputRef: RefObject<HTMLInputElement | null>;
  onAddImages: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onToggleDelete: (id: number) => void;
  onRemoveNew: (index: number) => void;
  onCancel: () => void;
  onSave: () => void;
  onZoomClose: () => void;
}

export default function PrivateFolder({
  privateImages,
  privateNewFiles,
  privateDeletedIds,
  allImages,
  privateZoomIndex,
  setPrivateZoomIndex,
  privateFileInputRef,
  onAddImages,
  onToggleDelete,
  onRemoveNew,
  onCancel,
  onSave,
  onZoomClose,
}: PrivateFolderProps) {
  const visibleCount =
    privateImages.filter((img) => !privateDeletedIds.has(img.id)).length + privateNewFiles.length;

  const handleZoomPrev = () => {
    setPrivateZoomIndex((prev) => (prev !== null ? (prev - 1 + allImages.length) % allImages.length : null));
  };
  const handleZoomNext = () => {
    setPrivateZoomIndex((prev) => (prev !== null ? (prev + 1) % allImages.length : null));
  };

  /**
   * 打开全屏看图：Capacitor 原生环境下优先交给原生查看器（原生手势 + 下拉关闭）；
   * 不可用/打开失败（含列表里混有 blob: 未上传预览的情况）则回退 Web 覆盖层。
   * 私密图片走 /api/ 需要鉴权，token 由 authHeadersFor 统一附加。
   */
  const openZoom = (idx: number, thumbEl: Element | null) => {
    const urls = allImages.map((a) => resolveMediaUrl(a.url) || a.url);
    const rect = rectOf(thumbEl);
    void openNativeViewer({
      images: urls,
      index: idx,
      ...authHeadersFor(urls),
      ...(rect ? { rect } : {}),
    }).then((res) => {
      if (res === null) setPrivateZoomIndex(idx); // 回退 Web 覆盖层
    });
  };

  // 私密图片全屏：双指缩放/平移 + 双击放大/单击关闭（1x–4x）—— Web 回退路径。
  // 单击关闭两阶段编排：轻点后先不播动画，等双击窗口过去才淡出
  // （淡出早于窗口会让撤销期间透出下层页面 = 闪烁），窗口内可撤销转缩放
  const zoomOverlayRef = useRef<HTMLDivElement>(null);
  const pinchZoom = useImagePinchZoom();
  const zoomVisible = privateZoomIndex !== null;
  const { closing, requestClose, cancelClose } = useCancelableClose(onZoomClose);
  useEffect(() => {
    if (!zoomVisible) return;
    // 重新打开时复位上次会话的缩放状态（组件常驻，scaleRef 会残留）
    pinchZoom.reset();
    const detach = pinchZoom.attach(
      zoomOverlayRef.current,
      () => {
        const overlay = zoomOverlayRef.current;
        if (!overlay) return null;
        const img = overlay.querySelector('img');
        return img instanceof HTMLImageElement ? img : null;
      },
      { onSingleTap: requestClose, onSingleTapCancelled: cancelClose }
    );
    return detach;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomVisible]);

  return (
    <>
      <div className={styles.overlay} onClick={onCancel}>
        <div className={`${styles.modal} ${styles.modalLg}`} onClick={(e) => e.stopPropagation()}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 16,
            }}
          >
            <h3 style={{ margin: 0 }}>私密文件夹</h3>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{visibleCount}/10</span>
          </div>
          <div className={styles.images}>
            {privateImages
              .filter((img) => !privateDeletedIds.has(img.id))
              .map((img) => (
                <div key={img.id} className={styles.previewItem}>
                  <AuthImg
                    url={img.image_url}
                    alt=""
                    className={styles.zoomImg}
                    onClick={(e) => {
                      const idx = allImages.findIndex((a) => a.type === 'existing' && a.id === img.id);
                      if (idx >= 0) openZoom(idx, e.currentTarget);
                    }}
                  />
                  <button
                    className={styles.deleteX}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleDelete(img.id);
                    }}
                    aria-label="删除图片"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            {privateNewFiles.map((item, i) => (
              <div key={`new-${i}`} className={`${styles.previewItem} ${styles.newFile}`}>
                <img
                  src={item.preview}
                  alt=""
                  className={styles.zoomImg}
                  onClick={(e) => {
                    const idx = allImages.findIndex((a) => a.type === 'new' && a.index === i);
                    // 未上传的新文件是 blob: 预览，原生抓不到 → openNativeViewer
                    // 内部会返回 null，自动落到 Web 覆盖层
                    if (idx >= 0) openZoom(idx, e.currentTarget);
                  }}
                />
                <button
                  className={styles.deleteX}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveNew(i);
                  }}
                  aria-label="移除图片"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
            {visibleCount < 10 && (
              <div className={styles.add} onClick={() => privateFileInputRef.current?.click()}>
                <ImagePlus size={24} />
                <span>添加</span>
              </div>
            )}
          </div>
          <input
            ref={privateFileInputRef}
            type="file"
            accept="image/jpeg,image/jpg,image/png,image/gif,image/webp,image/avif,image/heic,image/heif"
            multiple
            style={{ display: 'none' }}
            onChange={onAddImages}
          />
          <div className={styles.modalActions}>
            <button className="profile-cancel-btn" onClick={onCancel}>
              取消
            </button>
            <button className="profile-save-btn" onClick={onSave}>
              保存
            </button>
          </div>
        </div>
      </div>

      {privateZoomIndex !== null &&
        (() => {
          const current = allImages[privateZoomIndex];
          if (!current) return null;
          return (
            <div
              ref={zoomOverlayRef}
              className={`${media.zoomOverlay}${closing ? ` ${media.closing}` : ''}`}
              onClick={requestClose}
            >
              <button className={media.close} onClick={requestClose} aria-label="关闭预览">
                <X size={28} />
              </button>
              <div className={media.zoomContent}>
                {allImages.length > 1 && (
                  <button
                    className={`${media.zoomNav} ${media.zoomPrev}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleZoomPrev();
                    }}
                    aria-label="上一张"
                  >
                    <ChevronLeft size={32} />
                  </button>
                )}
                <AuthImg
                  url={current.url}
                  alt=""
                  className={media.zoomImage}
                  onClick={(e) => {
                    e.stopPropagation();
                    requestClose();
                  }}
                />
                {allImages.length > 1 && (
                  <button
                    className={`${media.zoomNav} ${media.zoomNext}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleZoomNext();
                    }}
                    aria-label="下一张"
                  >
                    <ChevronRight size={32} />
                  </button>
                )}
                {allImages.length > 1 && (
                  <div className={media.zoomDots}>
                    {allImages.map((_, i) => (
                      <span
                        key={i}
                        className={`${media.imageDot} ${i === privateZoomIndex ? media.active : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setPrivateZoomIndex(i);
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })()}
    </>
  );
}
