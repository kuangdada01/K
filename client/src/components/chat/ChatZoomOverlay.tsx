/**
 * ============================================================
 * 聊天图片缩放遮罩 (ChatZoomOverlay)
 * ============================================================
 * 点击消息图片后的全屏预览，按能力分流：
 * - **Capacitor 原生环境**：交给原生查看器（NativeImageViewer：原生缩放手势 +
 *   下拉关闭），直接回调 onClose 让父级卸载，不渲染任何 Web 覆盖层；
 * - **网页端/桌面，或原生不可用/打开失败**：退回下面的 Web 覆盖层（Web 实现）。
 *
 * Web 覆盖层（ChatZoomOverlayWeb）行为：
 * 双指缩放/平移（useImagePinchZoom，1x–4x）；单击关闭为两阶段编排——
 * 轻点后**先不播任何动画**，等双击窗口（+余量）过去确认不会再有第二次轻点才淡出，
 * 窗口内第二次轻点撤销关闭并转双击缩放（useCancelableClose）；
 * 因淡出晚于双击窗口，撤销时遮罩透明度从未变化 —— 既不透出下层消息列表，
 * 也不存在「animation 切换导致入场动画重播」的闪烁。
 */

import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { resolveMediaUrl } from '../../utils';
import { useImagePinchZoom } from '../../hooks/useImagePinchZoom';
import { useCancelableClose } from '../../hooks/useCancelableClose';
import { authHeadersFor, isNativeViewerAvailable, openNativeViewer } from '../../lib/nativeImageViewer';
import styles from './ChatZoomOverlay.module.css';

interface ChatZoomOverlayProps {
  zoomImage: string;
  /** 关闭动画结束后回调（父级卸载 overlay） */
  onClose: () => void;
}

export default function ChatZoomOverlay({ zoomImage, onClose }: ChatZoomOverlayProps) {
  // 已知原生不可用 → 直接用 Web 覆盖层（避免先渲染再切换的闪动）；
  // 原生打开失败时也会置回 true 回退
  const [useWeb, setUseWeb] = useState(() => !isNativeViewerAvailable());
  const openedRef = useRef(false);

  useEffect(() => {
    if (useWeb || openedRef.current) return;
    openedRef.current = true;
    const url = resolveMediaUrl(zoomImage) || zoomImage;
    void openNativeViewer({ images: [url], index: 0, ...authHeadersFor([url]) }).then((res) => {
      if (res === null) {
        setUseWeb(true); // 原生没接住 → 回退 Web 覆盖层
        return;
      }
      onClose(); // 原生查看器已关闭：让父级把 zoomImage 置空
    });
  }, [useWeb, zoomImage, onClose]);

  if (!useWeb) return null;
  return <ChatZoomOverlayWeb zoomImage={zoomImage} onClose={onClose} />;
}

/** Web 覆盖层实现（原生不可用时的回退路径，行为与改动前一致） */
function ChatZoomOverlayWeb({ zoomImage, onClose }: ChatZoomOverlayProps) {
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
