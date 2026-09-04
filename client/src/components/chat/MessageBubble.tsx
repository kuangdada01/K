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
}: MessageBubbleProps) {
  // 消息图片/引用缩略图为鉴权接口 URL，需拉取 blob 后展示
  const imageUrl = useAuthMediaUrl(msg.image_url);
  const quotedImageUrl = useAuthMediaUrl(
    msg.quoted_image_url && !msg.quoted_content ? msg.quoted_image_url : null
  );

  return (
    <Fragment key={msg.id}>
      <div
        className={`${styles.row} ${isSent ? styles.sent : styles.received}`}
        data-msg-id={msg.id}
      >
        <Avatar src={avatar} username={name || ''} size={32} className={styles.msgAvatar} />
        <div
          className={`${styles.bubbleWrapper} ${isSent ? styles.sent : styles.received}`}
          onContextMenu={e => onContextMenu(e, msg)}
          onTouchStart={e => onTouchStart(e, msg)}
          onTouchEnd={onTouchEnd}
          onTouchMove={onTouchMove}
        >
          {msg.image_url ? (
            imageUrl ? (
              <img src={imageUrl} alt="图片" className={styles.messageImage} onClick={() => onZoomImage(imageUrl)} />
            ) : null
          ) : (
            <div className={`${styles.message} ${isSent ? styles.sent : styles.received}`}>
              {msg.content}
            </div>
          )}
          {msg.quoted_message_id && (
            <div className={`${styles.messageQuote} ${isSent ? styles.sent : styles.received}`} onClick={() => onScrollToMessage(msg.quoted_message_id!)}>
              {quotedImageUrl && !msg.quoted_content ? (
                <div className={styles.quoteImg}>
                  <div className={styles.quoteUserName}>{msg.quoted_sender_username}:</div>
                  <img className={styles.quoteThumb} src={quotedImageUrl} alt="" />
                </div>
              ) : (
                <span>{msg.quoted_sender_username}: {msg.quoted_content || '[消息]'}</span>
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
