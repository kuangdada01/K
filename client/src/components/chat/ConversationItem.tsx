/**
 * ============================================================
 * 会话列表项组件 (ConversationItem)
 * ============================================================
 * 私信页左侧的单个会话条目
 * ============================================================
 */

import { Conversation } from '../../types';
import { formatLastMessageTime } from '../../utils';
import Avatar from '../ui/Avatar';
import styles from './ConversationItem.module.css';

interface ConversationItemProps {
  conv: Conversation;
  active: boolean;
  onClick: (conv: Conversation) => void;
}

export default function ConversationItem({ conv, active, onClick }: ConversationItemProps) {
  return (
    <button
      key={conv.partner_id}
      className={`${styles.item} ${active ? styles.active : ''}`}
      onClick={() => onClick(conv)}
    >
      <Avatar src={conv.avatar} username={conv.username} size={44} className={styles.avatar} />
      <div className={styles.info}>
        <div className={styles.username}>{conv.username}</div>
        <div className={styles.preview}>{conv.last_message || '[图片]'}</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
        <span className={styles.time}>{formatLastMessageTime(conv.last_message_at)}</span>
        {conv.unread_count > 0 && (
          <span className={styles.badge}>{conv.unread_count}</span>
        )}
      </div>
    </button>
  );
}
