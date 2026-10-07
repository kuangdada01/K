/**
 * ============================================================
 * 创建帖子第 1 步：选择媒体（MediaPickerStep）
 * ============================================================
 * 自 CreatePost.tsx 拆出（渲染逐字节不变）：图片网格（最多 9 张 + 拖拽排序 +
 * HEIC 占位图兜底）、选择照片/视频卡片、上传提示、隐藏 file input 与放弃确认框。
 * 纯展示组件：state 与 handler 全部由 props 注入（含图片数组本身，供拖拽实时重排）；
 * 拖拽状态（useImageGridDrag）为本步私有——仅在媒体选择步骤使用。
 */

import type { ChangeEvent, Dispatch, RefObject, SetStateAction } from 'react';
import { ImagePlus, Video, X } from 'lucide-react';
import ConfirmDialog from '../ui/ConfirmDialog';
import { IMAGE_PREVIEW_FALLBACK } from '../../utils';
import { useImageGridDrag } from '../../hooks/useImageGridDrag';
import styles from './CreatePost.module.css';
import composer from './PostComposer.module.css';

/** 图片条目（CreatePost 语义：统一数组，拖拽=上传顺序） */
export interface MediaPickerItem {
  url: string;
  file: File;
}

interface MediaPickerStepProps {
  images: MediaPickerItem[];
  setImages: Dispatch<SetStateAction<MediaPickerItem[]>>;
  hasContent: boolean;
  closing: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  videoInputRef: RefObject<HTMLInputElement | null>;
  onFileSelect: (e: ChangeEvent<HTMLInputElement>) => void;
  onVideoSelect: (e: ChangeEvent<HTMLInputElement>) => void;
  onRemoveImage: (index: number) => void;
  onDiscard: () => void;
  onContinue: () => void;
  showDiscardConfirm: boolean;
  onDiscardConfirm: () => void;
  onDiscardCancel: () => void;
}

export default function MediaPickerStep({
  images,
  setImages,
  hasContent,
  closing,
  fileInputRef,
  videoInputRef,
  onFileSelect,
  onVideoSelect,
  onRemoveImage,
  onDiscard,
  onContinue,
  showDiscardConfirm,
  onDiscardConfirm,
  onDiscardCancel,
}: MediaPickerStepProps) {
  // 图片拖拽排序（按下即拖，实时重排；见 hooks/useImageGridDrag）
  const { dragIndex, gridRefs, handlers: dragHandlers } = useImageGridDrag(setImages);

  const renderGrid = () => {
    return (
      <div className={composer.gridWrapper} data-testid="media-grid">
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
              data-testid="media-grid-item"
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
                  onRemoveImage(i);
                }}
              >
                <X size={14} />
              </button>
            </div>
          ))}
          {images.length < 9 && (
            <div
              className={composer.gridAdd}
              data-testid="media-grid-add"
              onClick={() => fileInputRef.current?.click()}
            >
              <ImagePlus size={28} />
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div
      className={`${composer.overlay}${closing ? ` ${composer.closing}` : ''}`}
      onPointerMove={dragHandlers.onPointerMove}
      onPointerUp={dragHandlers.onPointerUp}
      onPointerCancel={dragHandlers.onPointerCancel}
    >
      <div
        className={`${composer.dialog}${closing ? ` ${composer.closing}` : ''}`}
        data-testid="composer-dialog"
      >
        <div className={composer.overlayHeader}>
          <button className={`${composer.overlayBtn} ${composer.danger}`} data-back onClick={onDiscard}>
            放弃
          </button>
          <span className={composer.overlayTitle}>选择照片/视频</span>
          <button
            className={`${composer.overlayBtn} ${composer.primary}`}
            onClick={onContinue}
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
            onChange={onFileSelect}
          />
          <input
            ref={videoInputRef}
            type="file"
            accept="video/mp4,video/quicktime"
            style={{ display: 'none' }}
            onChange={onVideoSelect}
          />
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
