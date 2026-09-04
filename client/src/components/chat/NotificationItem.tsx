/**
 * ============================================================
 * 通知列表项组件 (NotificationItem)
 * ============================================================
 * 私信页通知标签页中的单条通知
 * ============================================================
 */

import { Notification } from '../../types';
import { formatLastMessageTime } from '../../utils';
import Avatar from '../ui/Avatar';
import styles from './ConversationItem.module.css';

interface NotificationItemProps {
  notif: Notification;
  onClick: (notif: Notification) => void;
}

export default function NotificationItem({ notif, onClick }: NotificationItemProps) {
  return (
    <button
      key={notif.id}
      className={`${styles.item} ${!notif.read ? styles.unread : ''}`}
      onClick={() => onClick(notif)}
    >
      <Avatar src={notif.from_avatar} username={notif.from_username} size={44} className={styles.avatar} />
      <div className={styles.info}>
        <div className={styles.username}>{notif.from_username}</div>
        <div className={styles.preview}>
          {notif.type === 'reply' ? '回复了你的评论' : notif.type === 'comment' ? '评论了你的帖子' : '给你发了消息'}: {notif.content}
        </div>
      </div>
      <div className={styles.right}>
        <span className={styles.time}>{formatLastMessageTime(notif.created_at)}</span>
        {!notif.read && <span className={styles.unreadDot} />}
      </div>
    </button>
  );
}
