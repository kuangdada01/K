/**
 * ============================================================
 * 私密文件夹 (PrivateFolder)
 * ============================================================
 * 个人主页的私密图片管理弹窗 + 缩放查看（纯展示组件，
 * 数据与行为回调由 Profile 提供）。
 */

import { RefObject } from 'react';
import { X, ImagePlus, ChevronLeft, ChevronRight } from 'lucide-react';
import { useAuthMediaUrl } from '../../hooks/useAuthMediaUrl';
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
                    onClick={() => {
                      const idx = allImages.findIndex((a) => a.type === 'existing' && a.id === img.id);
                      if (idx >= 0) setPrivateZoomIndex(idx);
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
                  onClick={() => {
                    const idx = allImages.findIndex((a) => a.type === 'new' && a.index === i);
                    if (idx >= 0) setPrivateZoomIndex(idx);
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
            <div className={media.zoomOverlay} onClick={onZoomClose}>
              <button className={media.close} onClick={onZoomClose} aria-label="关闭预览">
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
                    onZoomClose();
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
