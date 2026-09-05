/**
 * ============================================================
 * 侧边栏组件 (Sidebar)
 * ============================================================
 * 左侧导航栏（参考稿 premium-celadon/obsidian 样式）
 *
 * 功能:
 * - 品牌区: K 渐变标 + 品牌名 Kuangdada
 * - 公开导航: 首页、搜索、图书（无需登录）
 * - 需登录导航: 消息、分享、公告、主页、管理（管理员）
 * - 未读消息徽章 / 未读公告徽章（仅登录用户，30秒轮询 + SSE）
 * - 底部用户 Chip：点击头像打开二级菜单（个人主页 / 主题 / 退出登录）
 * - 移动端自动变为底部导航栏（CSS媒体查询，含头像入口）
 * ============================================================
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  Home,
  Search,
  MessageCircle,
  PlusSquare,
  User,
  Megaphone,
  Shield,
  BookOpen,
  AudioLines,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useEvent } from '../context/EventContext';
import { useVoiceInRoom } from '../context/VoiceContext';
import { events } from '../state/events';
import { useSse } from '../hooks/useSse';
import { saveHomeScrollPosition, getScrollTarget } from '../lib/scroll';
import api from '../api/http';
import AvatarMenu from './AvatarMenu';
import styles from './Sidebar.module.css';

export default function Sidebar() {
  const [unreadCount, setUnreadCount] = useState(0);
  const [announcementCount, setAnnouncementCount] = useState(0);
  const location = useLocation();
  const { user } = useAuth();
  const { openCreate } = useEvent();
  const inRoom = useVoiceInRoom();

  // 乐观更新追踪：记录服务器尚未确认的已读条数
  const pendingReads = useRef(0);
  const lastServerTotal = useRef(0);

  const loadUnread = useCallback(async () => {
    if (!user) return;
    try {
      const [notifRes, convRes, annRes] = await Promise.all([
        api.get('/notifications'),
        api.get('/messages/conversations'),
        api.get('/announcements').catch(() => ({ data: { unread_count: 0 } })),
      ]);
      const notifCount = notifRes.data.unread_count || 0;
      const msgCount = (convRes.data.conversations || []).reduce(
        (sum: number, c: { unread_count?: number }) => sum + (c.unread_count || 0),
        0
      );
      const serverTotal = notifCount + msgCount;

      // 服务器确认了部分已读（总量下降）→ 减少 pending
      if (serverTotal < lastServerTotal.current) {
        pendingReads.current = Math.max(0, pendingReads.current - (lastServerTotal.current - serverTotal));
      }
      lastServerTotal.current = serverTotal;

      // 用服务器值减去未确认的已读数，防止乐观更新的角标被旧数据覆盖
      setUnreadCount(Math.max(0, serverTotal - pendingReads.current));
      setAnnouncementCount(annRes.data.unread_count || 0);
    } catch {}
  }, [user]);

  // 定时轮询 (30秒) - 仅登录用户（SSE 失败时的兜底）
  useEffect(() => {
    if (!user) return;
    loadUnread();
    const interval = setInterval(loadUnread, 30000);
    return () => clearInterval(interval);
  }, [loadUnread, user]);

  // SSE 实时推送：新消息/通知/公告到达时立即刷新角标
  useSse(user?.id, (type) => {
    if (type === 'message' || type === 'notification' || type === 'announcement') {
      loadUnread();
    }
  });

  // 已读事件（mitt 总线）：立即乐观更新角标 + 后台确认
  // 历史语义：notif 每条已读 -1，msg 按实际条数扣减，公告直接刷新
  useEffect(() => {
    const handler = (payload: { source: 'notif' | 'msg' | 'ann'; count?: number }) => {
      if (!user) return;
      if (payload.source === 'msg') {
        const delta = payload.count ?? 1;
        if (delta > 0) {
          pendingReads.current += delta;
          setUnreadCount((prevCount) => Math.max(0, prevCount - delta));
        }
      } else if (payload.source === 'notif') {
        pendingReads.current += 1;
        setUnreadCount((prevCount) => Math.max(0, prevCount - 1));
      }
      loadUnread();
    };
    events.on('badge:changed', handler);
    return () => {
      events.off('badge:changed', handler);
    };
  }, [user, loadUnread]);

  const isActive = (path: string) => {
    if (path === '/') return location.pathname === '/';
    return location.pathname.startsWith(path);
  };

  const itemClass = (path: string) => `${styles.item} ${isActive(path) ? styles.active : ''}`;

  const lastHomeClickRef = useRef(0);
  const goHome = (e: React.MouseEvent) => {
    if (location.pathname === '/') {
      const now = Date.now();
      const isDouble = now - lastHomeClickRef.current < 350;
      lastHomeClickRef.current = now;
      if (isDouble) {
        e.preventDefault();
        const target = getScrollTarget();
        if (target === window) window.scrollTo({ top: 0, behavior: 'smooth' });
        else (target as HTMLElement).scrollTo({ top: 0, behavior: 'smooth' });
        // 清除持久化的滚动，避免切页后又被 useScrollRestore 拉回原位
        try {
          sessionStorage.removeItem('home_scrollY');
        } catch {}
        return;
      }
      saveHomeScrollPosition();
    }
  };

  return (
    <nav className={styles.sidebar}>
      {/* 品牌区 */}
      <div className={styles.brand}>
        <span className={styles.brandMark}>K</span>
        <span className={styles.brandName}>Kuangdada</span>
      </div>

      <div className={styles.nav}>
        <Link to="/" className={itemClass('/')} onClick={goHome}>
          <span className={styles.itemIcon}>
            <Home size={22} />
          </span>
          <span className={styles.itemLabel}>首页</span>
        </Link>
        <Link to="/explore" className={`${itemClass('/explore')} ${styles.itemSearch}`} onClick={goHome}>
          <span className={styles.itemIcon}>
            <Search size={22} />
          </span>
          <span className={styles.itemLabel}>搜索</span>
        </Link>
        {user && (
          <Link to="/messages" className={itemClass('/messages')} onClick={goHome}>
            <span className={styles.itemIcon}>
              <MessageCircle size={22} />
              {unreadCount > 0 && <span className={styles.badge}>{unreadCount}</span>}
            </span>
            <span className={styles.itemLabel}>消息</span>
          </Link>
        )}
        {user && (
          <button className={styles.item} onClick={openCreate}>
            <span className={styles.itemIcon}>
              <PlusSquare size={22} />
            </span>
            <span className={styles.itemLabel}>分享</span>
          </button>
        )}
        {user && (
          <Link to="/announcements" className={itemClass('/announcements')} onClick={goHome}>
            <span className={styles.itemIcon}>
              <Megaphone size={22} />
              {announcementCount > 0 && <span className={styles.badge}>{announcementCount}</span>}
            </span>
            <span className={styles.itemLabel}>公告</span>
          </Link>
        )}
        <Link to="/books" className={itemClass('/books')} onClick={goHome}>
          <span className={styles.itemIcon}>
            <BookOpen size={22} />
          </span>
          <span className={styles.itemLabel}>图书</span>
        </Link>
        <Link to="/voice" className={itemClass('/voice')} onClick={goHome}>
          <span className={styles.itemIcon}>
            <AudioLines size={22} />
          </span>
          <span className={styles.itemLabel}>
            语音
            {inRoom && <span className={styles.voiceDot} title="语音进行中" />}
          </span>
        </Link>
        {user && (
          <Link to="/profile" className={itemClass('/profile')} onClick={goHome}>
            <span className={styles.itemIcon}>
              <User size={22} />
            </span>
            <span className={styles.itemLabel}>主页</span>
          </Link>
        )}
        {user?.role === 'admin' && (
          <Link to="/admin" className={itemClass('/admin')} onClick={goHome}>
            <span className={styles.itemIcon}>
              <Shield size={22} />
            </span>
            <span className={styles.itemLabel}>管理</span>
          </Link>
        )}
      </div>

      {/* 底部用户 Chip（点击打开二级菜单：个人主页 + 主题 + 退出登录） */}
      <div className={styles.bottom}>
        <AvatarMenu
          showUsername
          subtitle={user?.bio || (user ? 'k' : '登录后即可互动')}
          size={40}
          triggerClassName={styles.userChipTrigger}
        />
      </div>
    </nav>
  );
}
