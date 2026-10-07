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
 *
 * 数据层（§4.2）：手写 loading/error/数据 状态收敛为 useQuery——
 * 请求时机不变（挂载即取、失败不重试），错误 toast 文案不变，
 * markRead 乐观更新经 setQueryData 就地写入（不触发整页重载）。
 * ============================================================
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Megaphone, Bell } from 'lucide-react';
import api, { getApiErrorMessage } from '../api/http';
import type { Announcement } from '../types';
import { events } from '../state/events';
import { parseDbTime } from '../utils';
import { showToast } from '../components/ui/Toast';
import styles from './AnnouncementPage.module.css';

export default function AnnouncementPage() {
  const queryClient = useQueryClient();
  const announcementsQuery = useQuery({
    queryKey: ['announcements'],
    queryFn: async () => {
      try {
        const res = await api.get('/announcements');
        return res.data.announcements as Announcement[];
      } catch (err) {
        showToast(getApiErrorMessage(err, '公告加载失败'));
        throw err;
      }
    },
  });
  const announcements = announcementsQuery.data ?? [];
  const loading = announcementsQuery.isPending;

  const markRead = async (id: number) => {
    try {
      await api.put(`/announcements/${id}/read`);
      queryClient.setQueryData<Announcement[]>(['announcements'], (prev) =>
        (prev ?? []).map((a) => (a.id === id ? { ...a, is_read: 1 } : a))
      );
      events.emit('badge:changed', { source: 'ann' });
    } catch {
      showToast('标记已读失败');
    }
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
          {announcements.map((a) => (
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
