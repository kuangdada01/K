/**
 * ============================================================
 * 聊天图片缩放遮罩 (ChatZoomOverlay)
 * ============================================================
 * 点击消息图片后的全屏预览（纯展示组件）。
 * 支持双指缩放/平移（useImagePinchZoom，1x–4x）。
 */

import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { resolveMediaUrl } from '../../utils';
import { useImagePinchZoom } from '../../hooks/useImagePinchZoom';
import styles from './ChatZoomOverlay.module.css';

interface ChatZoomOverlayProps {
  zoomImage: string;
  zoomClosing: boolean;
  onClose: () => void;
}

export default function ChatZoomOverlay({ zoomImage, zoomClosing, onClose }: ChatZoomOverlayProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const pinchZoom = useImagePinchZoom();

  // 双指缩放/平移 + 双击放大/单击关闭：绑定到遮罩与图片（图片就绪后 attach 内惰性取元素）。
  // onSingleTap：触摸轻点（非双击）延迟关闭——双击由 hook 判定缩放，互不冲突；
  // 桌面鼠标单击仍走 overlay/img 的 onClick（触摸 click 已被 hook 吞掉）
  useEffect(() => {
    const detach = pinchZoom.attach(overlayRef.current, () => imgRef.current, { onSingleTap: onClose });
    return detach;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={overlayRef}
      className={`${styles.overlay}${zoomClosing ? ` ${styles.closing}` : ''}`}
      onClick={onClose}
    >
      <button className={styles.close} onClick={onClose} aria-label="关闭预览">
        <X size={28} />
      </button>
      <img
        ref={imgRef}
        src={resolveMediaUrl(zoomImage) || ''}
        alt=""
        className={`${styles.image}${zoomClosing ? ` ${styles.closing}` : ''}`}
        onClick={onClose}
      />
    </div>
  );
}
