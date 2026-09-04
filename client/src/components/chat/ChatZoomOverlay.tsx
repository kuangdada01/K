/**
 * ============================================================
 * 聊天图片缩放遮罩 (ChatZoomOverlay)
 * ============================================================
 * 点击消息图片后的全屏预览（纯展示组件）。
 */

import { X } from 'lucide-react';
import { resolveMediaUrl } from '../../utils';
import styles from './ChatZoomOverlay.module.css';

interface ChatZoomOverlayProps {
  zoomImage: string;
  zoomClosing: boolean;
  onClose: () => void;
}

export default function ChatZoomOverlay({ zoomImage, zoomClosing, onClose }: ChatZoomOverlayProps) {
  return (
    <div className={`${styles.overlay}${zoomClosing ? ` ${styles.closing}` : ''}`} onClick={onClose}>
      <button className={styles.close} onClick={onClose} aria-label="关闭预览">
        <X size={28} />
      </button>
      <img src={resolveMediaUrl(zoomImage) || ''} alt="" className={`${styles.image}${zoomClosing ? ` ${styles.closing}` : ''}`} onClick={onClose} />
    </div>
  );
}
