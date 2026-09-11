/**
 * ============================================================
 * 聊天图片缩放遮罩 (ChatZoomOverlay)
 * ============================================================
 * 点击消息图片后的全屏预览（纯展示组件）。
 * 支持双指缩放/平移（useImagePinchZoom，1x–4x）。
 * 单击关闭：轻点后延迟 ~110ms 开始淡出（双击窗口内的第二下到达前不播淡出，
 * 双击缩放不闪烁），双击窗口内第二次轻点撤销关闭并转双击缩放；
 * 淡出/撤销共用同一条 opacity transition（可中断可反向），撤销时平滑淡回，
 * 不会像 animation 切换那样把入场动画从头重播（= 闪一下）。
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
  // onSingleTap：触摸轻点启动关闭（淡出延迟 ~110ms，双击可撤销）；
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
