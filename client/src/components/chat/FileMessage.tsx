/**
 * ============================================================
 * 文件消息气泡 (FileMessage)
 * ============================================================
 * 私信里的文件卡片：类型图标 + 原始名 + `大小 · 类型` + 下载/预览入口。
 *
 * 交互按"能不能预览"分流（与服务端的 inline 白名单同一口径）：
 *  · 可预览（图片/音视频/PDF/纯文本）→ 点卡片打开站内预览浮层；
 *  · 其余（压缩包/Office/电子书/html/svg…）→ 点卡片直接下载。
 * 两种情况下右侧的下载按钮都在，用户不用猜"点一下会发生什么"。
 */

import {
  Download,
  File,
  FileArchive,
  FileCode,
  FileText,
  Film,
  Image as ImageIcon,
  Music,
  Package,
} from 'lucide-react';
import type { Message } from '../../types';
import { fileKind, fileMetaText, isPreviewable } from '../../features/messages/utils/fileMessage';
import styles from './MessageBubble.module.css';

interface FileMessageProps {
  msg: Message;
  isSent: boolean;
  onPreview: (msg: Message) => void;
  onDownload: (msg: Message) => void;
}

/** 归类 → 图标 */
function KindIcon({ kind }: { kind: ReturnType<typeof fileKind> }) {
  switch (kind) {
    case 'image':
      return <ImageIcon size={22} />;
    case 'video':
      return <Film size={22} />;
    case 'audio':
      return <Music size={22} />;
    case 'pdf':
    case 'doc':
    case 'ebook':
      return <FileText size={22} />;
    case 'text':
      return <FileCode size={22} />;
    case 'archive':
      return <FileArchive size={22} />;
    // 安装包：盒子图标 + 归类文案「安装包」，与下载前的警示确认是同一套语义
    case 'app':
      return <Package size={22} />;
    default:
      return <File size={22} />;
  }
}

export default function FileMessage({ msg, isSent, onPreview, onDownload }: FileMessageProps) {
  const previewable = isPreviewable(msg);
  const openCard = () => {
    if (previewable) onPreview(msg);
    else onDownload(msg);
  };

  return (
    <div
      className={`${styles.fileCard} ${isSent ? styles.sent : styles.received}`}
      onClick={openCard}
      // 卡片整体可点，键盘也要能触发（role=button + Enter/Space）
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openCard();
        }
      }}
      title={previewable ? '点击预览' : '点击下载'}
    >
      <span className={styles.fileIcon}>
        <KindIcon kind={fileKind(msg)} />
      </span>
      <span className={styles.fileBody}>
        <span className={styles.fileName}>{msg.file_name || '文件'}</span>
        <span className={styles.fileMeta}>{fileMetaText(msg)}</span>
      </span>
      <button
        type="button"
        className={styles.fileAction}
        aria-label="下载"
        title="下载"
        onClick={(e) => {
          // 别让按钮的点击冒泡成"整卡点击"（否则预览型文件会被下载+预览同时触发）
          e.stopPropagation();
          onDownload(msg);
        }}
      >
        <Download size={18} />
      </button>
    </div>
  );
}
