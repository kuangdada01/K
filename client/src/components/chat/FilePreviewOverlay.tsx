/**
 * ============================================================
 * 文件预览浮层 (FilePreviewOverlay)
 * ============================================================
 * 私信文件在站内打开：图片 / 视频 / 音频 / PDF / 纯文本。
 *
 * 为什么统一走 blob URL：附件在 uploads_private，`<img src="/api/...">` 带不上
 * Authorization，只能先用 axios 取回二进制（useAuthMediaUrl 有共享缓存 + 引用计数，
 * 同一文件反复开关不会重复下载）。
 *
 * 二进制内容一律**当作"不可信文件"对待**：
 *  · 图片用 <img>（不是 iframe）；
 *  · 视频/音频用原生播放器；
 *  · PDF / 文本用 <iframe>（服务端对这些类型下发 inline + nosniff，且 CSP 只放行
 *    blob:，html/svg/xml 服务端根本不给 inline）；
 *  · 预览打不开时兜底提示"下载后查看"，不让用户对着一块空白猜。
 */

import { useEffect } from 'react';
import { Download, X } from 'lucide-react';
import type { Message } from '../../types';
import { useAuthMediaUrl } from '../../hooks/useAuthMediaUrl';
import {
  downloadMessageFile,
  fileKind,
  formatFileSize,
  kindLabel,
} from '../../features/messages/utils/fileMessage';
import { getApiErrorMessage } from '../../api/http';
import { showToast } from '../ui/Toast';
import styles from './FilePreviewOverlay.module.css';

interface FilePreviewOverlayProps {
  msg: Message;
  onClose: () => void;
}

export default function FilePreviewOverlay({ msg, onClose }: FilePreviewOverlayProps) {
  const url = useAuthMediaUrl(msg.file_url);
  const kind = fileKind(msg);

  // Esc 关闭（与图片缩放浮层一致的手感）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleDownload = async () => {
    try {
      await downloadMessageFile(msg);
    } catch (err) {
      showToast(getApiErrorMessage(err, '下载失败，请稍后重试'));
    }
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <div className={styles.titleGroup}>
            <span className={styles.title} title={msg.file_name || '文件'}>
              {msg.file_name || '文件'}
            </span>
            <span className={styles.subtitle}>
              {formatFileSize(msg.file_size)} · {kindLabel(kind)}
            </span>
          </div>
          <button className={styles.iconBtn} onClick={handleDownload} aria-label="下载" title="下载">
            <Download size={20} />
          </button>
          <button className={styles.iconBtn} onClick={onClose} aria-label="关闭预览" title="关闭">
            <X size={22} />
          </button>
        </div>

        <div className={styles.body}>
          {!url ? (
            <div className={styles.hint}>
              加载中…
              {/* 取流失败时 url 会一直是 null，这里给一条"直接下载"的出路 */}
              <button className={styles.downloadLink} onClick={handleDownload}>
                直接下载
              </button>
            </div>
          ) : kind === 'image' ? (
            <img className={styles.image} src={url} alt={msg.file_name || '图片'} />
          ) : kind === 'video' ? (
            <video className={styles.video} src={url} controls autoPlay playsInline />
          ) : kind === 'audio' ? (
            <div className={styles.audioBox}>
              <div className={styles.audioName}>{msg.file_name || '音频'}</div>
              <audio className={styles.audio} src={url} controls autoPlay />
            </div>
          ) : kind === 'pdf' || kind === 'text' ? (
            <div className={styles.frameWrap}>
              <iframe className={styles.frame} src={url} title={msg.file_name || '文件预览'} />
              {kind === 'pdf' && (
                // 部分 WebView（老 Android）没有内置 PDF 阅读器，iframe 会是空白；
                // 右上角一直有下载按钮，这里再明确说一句，别让人对着白屏猜
                <div className={styles.frameHint}>若上方空白，请点右上角下载后查看</div>
              )}
            </div>
          ) : (
            <div className={styles.hint}>
              该类型不支持预览
              <button className={styles.downloadLink} onClick={handleDownload}>
                下载后查看
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
