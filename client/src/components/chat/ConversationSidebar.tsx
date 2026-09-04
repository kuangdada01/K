/**
 * ============================================================
 * 私信侧栏 (ConversationSidebar)
 * ============================================================
 * Messages 左侧栏：用户搜索 + 私信/通知标签页 + 会话/通知列表
 * （纯展示组件，数据与行为回调由 Messages 提供）
 */

import { Search, MessageCircle, Bell } from 'lucide-react';
import type { Conversation, Notification, User } from '../../types';
import ConversationItem from './ConversationItem';
import NotificationItem from './NotificationItem';
import Avatar from '../ui/Avatar';
import styles from './ConversationSidebar.module.css';

interface ConversationSidebarProps {
  user: User | null;
  followSearch: string;
  setFollowSearch: (v: string) => void;
  showFollowResults: boolean;
  setShowFollowResults: (v: boolean) => void;
  searchResults: { id: number; username: string; avatar: string | null }[];
  onNavigateProfile: (userId: number) => void;
  activeTab: 'messages' | 'notifications';
  setActiveTab: (tab: 'messages' | 'notifications') => void;
  unreadNotifs: number;
  conversations: Conversation[];
  selectedPartnerId?: number;
  onSelectConversation: (conv: Conversation) => void;
  notifications: Notification[];
  onNotificationClick: (notif: Notification) => void;
}

export default function ConversationSidebar({
  user, followSearch, setFollowSearch, showFollowResults, setShowFollowResults,
  searchResults, onNavigateProfile, activeTab, setActiveTab, unreadNotifs,
  conversations, selectedPartnerId, onSelectConversation, notifications, onNotificationClick,
}: ConversationSidebarProps) {
  return (
    <div className={styles.sidebar}>
      <div className={styles.header}>
        <h2 className={styles.title}>{user?.username}</h2>
      </div>
      <div className={styles.followSearch}>
        <div className={styles.followSearchInputWrapper}>
          <Search size={14} className={styles.followSearchIcon} />
          <input
            className={styles.followSearchInput}
            placeholder="搜索用户"
            value={followSearch}
            onChange={e => setFollowSearch(e.target.value)}
            onFocus={() => setShowFollowResults(true)}
            onBlur={() => {
              setTimeout(() => setShowFollowResults(false), 200);
            }}
          />
        </div>
        {showFollowResults && searchResults.length > 0 && (
          <div className={styles.followResults}>
            {searchResults.map(u => (
              <button
                key={u.id}
                className={styles.followItem}
                onMouseDown={e => {
                  e.preventDefault();
                  setFollowSearch('');
                  setShowFollowResults(false);
                  onNavigateProfile(u.id);
                }}
              >
                <Avatar src={u.avatar} username={u.username} size={32} />
                <span className={styles.followItemName}>{u.username}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className={styles.tabs}>
        <button
          className={`${styles.tab} ${activeTab === 'messages' ? styles.active : ''}`}
          onClick={() => setActiveTab('messages')}
        >
          <MessageCircle size={16} />
          私信
        </button>
        <button
          className={`${styles.tab} ${activeTab === 'notifications' ? styles.active : ''}`}
          onClick={() => setActiveTab('notifications')}
        >
          <Bell size={16} />
          通知
          {unreadNotifs > 0 && <span className={styles.unreadBadge}>{unreadNotifs}</span>}
        </button>
      </div>
      <div className={styles.list}>
        {activeTab === 'messages' && conversations.map(conv => (
          <ConversationItem
            key={conv.partner_id}
            conv={conv}
            active={selectedPartnerId === conv.partner_id}
            onClick={onSelectConversation}
          />
        ))}
        {activeTab === 'notifications' && notifications.map(notif => (
          <NotificationItem
            key={notif.id}
            notif={notif}
            onClick={onNotificationClick}
          />
        ))}
        {activeTab === 'notifications' && notifications.length === 0 && (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-secondary)' }}>
            暂无通知
          </div>
        )}
      </div>
    </div>
  );
}
