/**
 * ============================================================
 * 公告页面 (AnnouncementPage)
 * ============================================================
 * 展示管理员发布的公告列表
 *
 * 功能:
 * - 公告列表（全局公告 + 定向公告）
 * - 已读/未读状态标记
 * - 点击标记为已读
 * ============================================================
 */

import { useState, useEffect } from 'react';
import { Megaphone, Bell } from 'lucide-react';
import api from '../api/http';
import { Announcement } from '../types';
import { events } from '../state/events';
import { parseDbTime } from '../utils';
import styles from './AnnouncementPage.module.css';

export default function AnnouncementPage() {
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/announcements')
      .then(res => setAnnouncements(res.data.announcements))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const markRead = async (id: number) => {
    try {
      await api.put(`/announcements/${id}/read`);
      setAnnouncements(prev => prev.map(a => a.id === id ? { ...a, is_read: 1 } : a));
      events.emit('badge:changed', { source: 'ann' });
    } catch {}
  };

  if (loading) {
    return <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-secondary)' }}>加载中...</div>;
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <Megaphone size={24} />
        <h1>公告</h1>
      </div>
      {announcements.length === 0 ? (
        <div className={styles.empty}>
          <Bell size={48} />
          <p>暂无公告</p>
        </div>
      ) : (
        <div className={styles.list}>
          {announcements.map(a => (
            <div
              key={a.id}
              className={`${styles.card} ${a.is_read ? '' : styles.unread}`}
              onClick={() => !a.is_read && markRead(a.id)}
            >
              <div className={styles.cardHeader}>
                <div className={styles.cardTitle}>{a.title}</div>
                {!a.is_read && <span className={styles.dot} />}
              </div>
              <div className={styles.cardContent}>{a.content}</div>
              <div className={styles.cardMeta}>
                <span>{a.from_username || '系统'}</span>
                <span>{parseDbTime(a.created_at).toLocaleString()}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}