/**
 * ============================================================
 * 聊天图片缩放遮罩 (ChatZoomOverlay)
 * ============================================================
 * 点击消息图片后的全屏预览（纯展示组件）。
 * 支持双指缩放/平移（useImagePinchZoom，1x–4x）。
 * 单击关闭：轻点后**先不播任何动画**，等双击窗口（+余量）过去、确认不会再有
 * 第二次轻点，才淡出关闭；窗口内第二次轻点撤销关闭并转双击缩放。
 * 因淡出晚于双击窗口，撤销时遮罩透明度从未变化 —— 既不会透出下层消息列表，
 * 也不存在「animation 切换导致入场动画重播」的闪烁。
 * （useCancelableClose + onSingleTapCancelled）；
 * 桌面鼠标点击仍走 overlay/img 的 onClick（触摸 click 已被 hook 吞掉）。
 * 关闭动画播完后由 onClose 通知父级卸载。
 */

import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { resolveMediaUrl } from '../../utils';
import { useImagePinchZoom } from '../../hooks/useImagePinchZoom';
import { useCancelableClose } from '../../hooks/useCancelableClose';
import styles from './ChatZoomOverlay.module.css';

interface ChatZoomOverlayProps {
  zoomImage: string;
  /** 关闭动画结束后回调（父级卸载 overlay） */
  onClose: () => void;
}

export default function ChatZoomOverlay({ zoomImage, onClose }: ChatZoomOverlayProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const pinchZoom = useImagePinchZoom();
  const { closing, requestClose, cancelClose } = useCancelableClose(onClose);

  // 双指缩放/平移 + 双击放大/单击关闭：绑定到遮罩与图片（图片就绪后 attach 内惰性取元素）。
  // onSingleTap：触摸轻点启动关闭（淡出晚于双击窗口，双击可撤销且无闪烁）；
  // onSingleTapCancelled：窗口内第二次轻点撤销关闭并转双击缩放。
  // 桌面鼠标单击仍走 overlay/img 的 onClick（触摸 click 已被 hook 吞掉）
  useEffect(() => {
    const detach = pinchZoom.attach(overlayRef.current, () => imgRef.current, {
      onSingleTap: requestClose,
      onSingleTapCancelled: cancelClose,
    });
    return detach;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={overlayRef}
      className={`${styles.overlay}${closing ? ` ${styles.closing}` : ''}`}
      onClick={requestClose}
    >
      <button className={styles.close} onClick={requestClose} aria-label="关闭预览">
        <X size={28} />
      </button>
      <img
        ref={imgRef}
        src={resolveMediaUrl(zoomImage) || ''}
        alt=""
        className={styles.image}
        onClick={requestClose}
      />
    </div>
  );
}
