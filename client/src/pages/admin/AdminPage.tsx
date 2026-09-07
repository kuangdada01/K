/**
 * ============================================================
 * 管理后台 (AdminPage) —— 状态编排层
 * ============================================================
 * 管理员专属页面，需要 admin 权限。
 *
 * 状态与数据逻辑全部集中在本组件（与拆分前一致：postPage/公告表单/
 * PostDetail 等跨 tab 切换保留）；三个 tab 的视图拆分到
 * AdminUsersTab / AdminPostsTab / AdminAnnouncementsTab（展示层）。
 * ============================================================
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Navigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { updatePostsFeed } from '../../hooks/usePostsFeed';
import { Users, FileText, Megaphone } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { showToast } from '../../components/ui/Toast';
import PostDetail from '../../components/post/PostDetail';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import api, { getApiErrorMessage } from '../../api/http';
import AdminUsersTab from './AdminUsersTab';
import AdminPostsTab from './AdminPostsTab';
import AdminAnnouncementsTab, { AnnSearchResult } from './AdminAnnouncementsTab';
import type { AdminUser, AdminPost, AdminAnnouncement } from './types';
import styles from '../AdminPage.module.css';

type Tab = 'users' | 'posts' | 'announcements';

export default function AdminPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>('users');

  // Users state
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [userSearch, setUserSearch] = useState('');

  // Posts state
  const [posts, setPosts] = useState<AdminPost[]>([]);
  const [postPage, setPostPage] = useState(1);
  const [postTotal, setPostTotal] = useState(0);
  const [postSearch, setPostSearch] = useState('');

  // Announcements state
  const [announcements, setAnnouncements] = useState<AdminAnnouncement[]>([]);
  const [showSendForm, setShowSendForm] = useState(false);
  const [annTitle, setAnnTitle] = useState('');
  const [annContent, setAnnContent] = useState('');
  const [annTargetId, setAnnTargetId] = useState<number | null>(null);
  const [annTargetName, setAnnTargetName] = useState('');
  const [annSearch, setAnnSearch] = useState('');
  const [annSearchResults, setAnnSearchResults] = useState<AnnSearchResult[]>([]);
  const [showAnnDropdown, setShowAnnDropdown] = useState(false);
  const annSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const annDropdownRef = useRef<HTMLDivElement>(null);
  // 请求序号守卫：快速翻页/切换 tab 时只允许最新请求的响应落地（§5.2，仿 ExplorePage）
  const reqSeqRef = useRef(0);

  // Confirm dialog
  const [confirmAction, setConfirmAction] = useState<(() => void) | null>(null);
  const [confirmMsg, setConfirmMsg] = useState('');

  // Password change
  const [pwTarget, setPwTarget] = useState<AdminUser | null>(null);
  const [banTarget, setBanTarget] = useState<AdminUser | null>(null);
  const [newPw, setNewPw] = useState('');

  // Post detail（页面级渲染：切换 tab 时保持打开，与历史实现一致）
  const [selectedPostId, setSelectedPostId] = useState<number | null>(null);

  useEffect(() => {
    // 数据加载内联在 effect 中（.then 回调内的 setState 属于异步回调，
    // 不触发 react-hooks/set-state-in-effect）
    const seq = ++reqSeqRef.current;
    if (tab === 'users') {
      api
        .get('/admin/users')
        .then((res) => {
          if (seq !== reqSeqRef.current) return; // 已有更新的请求，丢弃过期响应
          setUsers(res.data.users);
        })
        .catch((err) => {
          if (seq === reqSeqRef.current) showToast(getApiErrorMessage(err, '用户列表加载失败'));
        });
    } else if (tab === 'posts') {
      api
        .get(`/admin/posts?page=${postPage}&limit=20`)
        .then((res) => {
          if (seq !== reqSeqRef.current) return; // 已有更新的请求，丢弃过期响应
          setPosts(res.data.posts);
          setPostTotal(res.data.totalPages);
        })
        .catch((err) => {
          if (seq === reqSeqRef.current) showToast(getApiErrorMessage(err, '帖子列表加载失败'));
        });
    } else if (tab === 'announcements') {
      api
        .get('/admin/announcements')
        .then((res) => {
          if (seq !== reqSeqRef.current) return; // 已有更新的请求，丢弃过期响应
          setAnnouncements(res.data.announcements);
        })
        .catch((err) => {
          if (seq === reqSeqRef.current) showToast(getApiErrorMessage(err, '公告列表加载失败'));
        });
    }
  }, [tab, postPage]);

  const loadAnnouncements = useCallback(async () => {
    try {
      const res = await api.get('/admin/announcements');
      setAnnouncements(res.data.announcements);
    } catch (err) {
      showToast(getApiErrorMessage(err, '公告列表加载失败'));
    }
  }, []);

  const handleDeleteUser = (u: AdminUser) => {
    setConfirmMsg(`确定要删除用户 "${u.username}" 吗？该用户的帖子、评论等数据将一并删除。`);
    setConfirmAction(() => async () => {
      try {
        await api.delete(`/admin/users/${u.id}`);
        setUsers((prev) => prev.filter((x) => x.id !== u.id));
        showToast('用户已删除');
      } catch {
        showToast('删除失败');
      }
    });
  };

  // 封禁 / 解封
  const isBanned = (u: AdminUser) => !!u.banned_until && u.banned_until > new Date().toISOString();

  const handleBan = async (days: number) => {
    if (!banTarget) return;
    try {
      await api.post(`/admin/users/${banTarget.id}/ban`, { days });
      setUsers((prev) =>
        prev.map((x) =>
          x.id === banTarget.id
            ? { ...x, banned_until: new Date(Date.now() + days * 86400000).toISOString() }
            : x
        )
      );
      showToast(`已封禁 ${banTarget.username}`);
      setBanTarget(null);
    } catch {
      showToast('封禁失败');
    }
  };

  const handleUnban = async (u: AdminUser) => {
    try {
      await api.post(`/admin/users/${u.id}/unban`);
      setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, banned_until: null } : x)));
      showToast(`已解封 ${u.username}`);
    } catch {
      showToast('解封失败');
    }
  };

  const handleDeletePost = (p: AdminPost) => {
    setConfirmMsg(`确定要删除帖子 #${p.id} 吗？`);
    setConfirmAction(() => async () => {
      try {
        await api.delete(`/admin/posts/${p.id}`);
        setPosts((prev) => prev.filter((x) => x.id !== p.id));
        // 同步前台信息流缓存，删除后立即生效
        updatePostsFeed(queryClient, (prev) => prev.filter((x) => x.id !== p.id));
        showToast('帖子已删除');
      } catch {
        showToast('删除失败');
      }
    });
  };

  const handleDeleteAnn = (a: AdminAnnouncement) => {
    setConfirmMsg(`确定要删除公告 "${a.title}" 吗？`);
    setConfirmAction(() => async () => {
      try {
        await api.delete(`/admin/announcements/${a.id}`);
        setAnnouncements((prev) => prev.filter((x) => x.id !== a.id));
        showToast('公告已删除');
      } catch {
        showToast('删除失败');
      }
    });
  };

  const handleChangePw = async () => {
    if (!pwTarget || !newPw || newPw.length < 6) {
      showToast('密码至少需要6个字符');
      return;
    }
    try {
      await api.put(`/admin/users/${pwTarget.id}/password`, { password: newPw });
      showToast('密码已修改');
      setPwTarget(null);
      setNewPw('');
    } catch {
      showToast('修改失败');
    }
  };

  const handleSendAnn = async () => {
    if (!annTitle || !annContent) {
      showToast('请填写标题和内容');
      return;
    }
    try {
      await api.post('/admin/announcements', {
        title: annTitle,
        content: annContent,
        target_user_id: annTargetId,
      });
      showToast('公告已发送');
      setAnnTitle('');
      setAnnContent('');
      setAnnTargetId(null);
      setAnnTargetName('');
      setAnnSearch('');
      setShowSendForm(false);
      loadAnnouncements();
    } catch {
      showToast('发送失败');
    }
  };

  // 搜索用户（debounce）
  const handleAnnSearch = (value: string) => {
    setAnnSearch(value);
    setAnnTargetId(null);
    setAnnTargetName('');
    if (annSearchTimer.current) clearTimeout(annSearchTimer.current);
    if (!value.trim()) {
      setAnnSearchResults([]);
      setShowAnnDropdown(false);
      return;
    }
    annSearchTimer.current = setTimeout(async () => {
      try {
        const res = await api.get(`/admin/users/search?q=${encodeURIComponent(value.trim())}`);
        setAnnSearchResults(res.data.users);
        setShowAnnDropdown(true);
      } catch {}
    }, 300);
  };

  const selectAnnTarget = (u: { id: number; username: string }) => {
    setAnnTargetId(u.id);
    setAnnTargetName(u.username);
    setAnnSearch(u.username);
    setShowAnnDropdown(false);
  };

  const clearAnnTarget = () => {
    setAnnTargetId(null);
    setAnnTargetName('');
    setAnnSearch('');
    setAnnSearchResults([]);
    setShowAnnDropdown(false);
  };

  // 点击外部关闭下拉
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (annDropdownRef.current && !annDropdownRef.current.contains(e.target as Node)) {
        setShowAnnDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // 权限守卫：游客/非管理员在渲染前直接重定向回首页（消除闪帧并兜底游客访问）
  if (!user || user.role !== 'admin') return <Navigate to="/" replace />;

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>管理后台</h1>
      </div>

      <div className={styles.tabs}>
        <button
          className={`${styles.tab} ${tab === 'users' ? styles.active : ''}`}
          onClick={() => setTab('users')}
        >
          <Users size={18} /> 用户管理
        </button>
        <button
          className={`${styles.tab} ${tab === 'posts' ? styles.active : ''}`}
          onClick={() => setTab('posts')}
        >
          <FileText size={18} /> 帖子管理
        </button>
        <button
          className={`${styles.tab} ${tab === 'announcements' ? styles.active : ''}`}
          onClick={() => setTab('announcements')}
        >
          <Megaphone size={18} /> 公告管理
        </button>
      </div>

      <div>
        {tab === 'users' && (
          <AdminUsersTab
            users={users}
            userSearch={userSearch}
            setUserSearch={setUserSearch}
            isBanned={isBanned}
            onDelete={handleDeleteUser}
            onUnban={handleUnban}
            onSetBanTarget={setBanTarget}
            banTarget={banTarget}
            onBan={handleBan}
            pwTarget={pwTarget}
            setPwTarget={setPwTarget}
            newPw={newPw}
            setNewPw={setNewPw}
            onChangePw={handleChangePw}
          />
        )}

        {tab === 'posts' && (
          <AdminPostsTab
            posts={posts}
            postSearch={postSearch}
            setPostSearch={setPostSearch}
            postPage={postPage}
            setPostPage={setPostPage}
            postTotal={postTotal}
            onDelete={handleDeletePost}
            onOpenDetail={setSelectedPostId}
          />
        )}

        {tab === 'announcements' && (
          <AdminAnnouncementsTab
            announcements={announcements}
            showSendForm={showSendForm}
            setShowSendForm={setShowSendForm}
            annTitle={annTitle}
            setAnnTitle={setAnnTitle}
            annContent={annContent}
            setAnnContent={setAnnContent}
            annTargetId={annTargetId}
            annTargetName={annTargetName}
            annSearch={annSearch}
            annSearchResults={annSearchResults}
            showAnnDropdown={showAnnDropdown}
            setShowAnnDropdown={setShowAnnDropdown}
            annDropdownRef={annDropdownRef}
            onSearch={handleAnnSearch}
            onSelectTarget={selectAnnTarget}
            onClearTarget={clearAnnTarget}
            onSend={handleSendAnn}
            onDelete={handleDeleteAnn}
          />
        )}
      </div>

      {/* Post detail modal（页面级：切换 tab 保持打开） */}
      {selectedPostId && <PostDetail postId={selectedPostId} onClose={() => setSelectedPostId(null)} />}

      {/* Confirm dialog */}
      {confirmAction && (
        <ConfirmDialog
          message={confirmMsg}
          onConfirm={() => {
            confirmAction();
            setConfirmAction(null);
          }}
          onCancel={() => setConfirmAction(null)}
        />
      )}
    </div>
  );
}
