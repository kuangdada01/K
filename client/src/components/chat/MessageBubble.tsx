/**
 * ============================================================
 * 消息气泡组件 (MessageBubble)
 * ============================================================
 * 私信聊天中的单条消息（含图片、引用消息、时间分隔符）
 * 纯展示组件，交互通过回调交给 Messages 管理
 * ============================================================
 */

import { Fragment, memo } from 'react';
import { Message } from '../../types';
import { formatTimeSeparator } from '../../utils';
import { useAuthMediaUrl } from '../../hooks/useAuthMediaUrl';
import Avatar from '../ui/Avatar';
import VoiceMessage from './VoiceMessage';
import FileMessage from './FileMessage';
import styles from './MessageBubble.module.css';

interface MessageBubbleProps {
  msg: Message;
  isSent: boolean;
  avatar: string | null | undefined;
  name: string;
  showSeparator: boolean;
  onContextMenu: (e: React.MouseEvent, msg: Message) => void;
  onTouchStart: (e: React.TouchEvent, msg: Message) => void;
  onTouchEnd: (e: React.TouchEvent) => void;
  onTouchMove: (e: React.TouchEvent) => void;
  onZoomImage: (imageUrl: string) => void;
  onScrollToMessage: (messageId: number) => void;
  onPreviewFile: (msg: Message) => void;
  onDownloadFile: (msg: Message) => void;
}

/** 引用条的内容摘要：纯图片/语音/文件也要有可读文字（content 可能为空） */
function quotePreviewText(msg: Message): string {
  if (msg.quoted_content) return msg.quoted_content;
  if (msg.quoted_file_name) return `[文件] ${msg.quoted_file_name}`;
  if (msg.quoted_audio_url) return '[语音]';
  return '[消息]';
}

function MessageBubble({
  msg,
  isSent,
  avatar,
  name,
  showSeparator,
  onContextMenu,
  onTouchStart,
  onTouchEnd,
  onTouchMove,
  onZoomImage,
  onScrollToMessage,
  onPreviewFile,
  onDownloadFile,
}: MessageBubbleProps) {
  // 消息图片/引用缩略图为鉴权接口 URL，需拉取 blob 后展示
  const imageUrl = useAuthMediaUrl(msg.image_url);
  const quotedImageUrl = useAuthMediaUrl(
    msg.quoted_image_url && !msg.quoted_content ? msg.quoted_image_url : null
  );

  return (
    <Fragment key={msg.id}>
      <div className={`${styles.row} ${isSent ? styles.sent : styles.received}`} data-msg-id={msg.id}>
        <Avatar src={avatar} username={name || ''} size={32} className={styles.msgAvatar} />
        <div
          className={`${styles.bubbleWrapper} ${isSent ? styles.sent : styles.received}`}
          onContextMenu={(e) => onContextMenu(e, msg)}
          onTouchStart={(e) => onTouchStart(e, msg)}
          onTouchEnd={onTouchEnd}
          onTouchMove={onTouchMove}
        >
          {msg.audio_url ? (
            <VoiceMessage key={msg.id} msg={msg} isSent={isSent} />
          ) : msg.file_url ? (
            <FileMessage msg={msg} isSent={isSent} onPreview={onPreviewFile} onDownload={onDownloadFile} />
          ) : msg.image_url ? (
            imageUrl ? (
              <img
                src={imageUrl}
                alt="图片"
                className={styles.messageImage}
                onClick={() => onZoomImage(imageUrl)}
              />
            ) : null
          ) : (
            <div className={`${styles.message} ${isSent ? styles.sent : styles.received}`}>{msg.content}</div>
          )}
          {msg.quoted_message_id && (
            <div
              className={`${styles.messageQuote} ${isSent ? styles.sent : styles.received}`}
              onClick={() => onScrollToMessage(msg.quoted_message_id!)}
            >
              {quotedImageUrl && !msg.quoted_content ? (
                <div className={styles.quoteImg}>
                  <div className={styles.quoteUserName}>{msg.quoted_sender_username}:</div>
                  <img className={styles.quoteThumb} src={quotedImageUrl} alt="" />
                </div>
              ) : (
                <span>
                  {msg.quoted_sender_username}: {quotePreviewText(msg)}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      {showSeparator && (
        <div className={styles.timeSeparator}>
          <span>{formatTimeSeparator(msg.created_at)}</span>
        </div>
      )}
    </Fragment>
  );
}

// P9 修复：气泡 memo 化——输入框每击键不再重渲染整列表
export default memo(MessageBubble);
