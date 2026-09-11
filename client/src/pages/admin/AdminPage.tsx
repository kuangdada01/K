/**
 * ============================================================
 * 管理后台 (AdminPage) —— 状态编排层
 * ============================================================
 * 管理员专属页面，需要 admin 权限。
 *
 * 数据层（§4.2）：三 tab 列表手写 effect + 请求序号守卫收敛为三个
 * useQuery（enabled 按 tab 门控、key 含分页参数）——
 * - 请求时机不变：进入 tab / 翻页即取，失败不重试；原 reqSeqRef 的
 *   「过期响应丢弃」由 query key 的 latest-wins 天然覆盖
 * - 切换 tab 保留旧数据（缓存常驻），切回/翻页时 keepPreviousData
 *   保持「旧列表先显示、新数据到达后替换」的历史 UI
 * - 删除/封禁/解封的乐观更新经 setQueryData 就地写入，不整页重载；
 *   发送公告后 invalidateQueries 触发列表重取（等价原 loadAnnouncements）
 * - 目标用户搜索下拉保持原实现（防抖 + 选中跳过标记 + 序号守卫）
 *
 * 用户/帖子两个 tab 的搜索与分页**都已改为服务端**（此前是「本地过滤」：
 * 用户 tab 只看得到封顶的 500 行，帖子 tab 只看得到当前页 20 行，因此超出范围的
 * 记录搜不到、也就封禁/改密/删除不了）——query key 分别为
 * ['admin','users',page,q] 与 ['admin','posts',page,q]，q 走 300ms 防抖，
 * 翻页/改词保留旧页显示。
 * 用户列表的老客户端（不带 page 参数的已安装 APK）仍拿老的 `{users, has_more}`
 * 形状，服务端两种形状并存，见 routes/admin/users.routes.ts。
 *
 * 状态与数据逻辑全部集中在本组件；三个 tab 的视图拆分到
 * AdminUsersTab / AdminPostsTab / AdminAnnouncementsTab（展示层）。
 * ============================================================
 */

import { useState, useEffect, useRef } from 'react';
import { Navigate } from 'react-router-dom';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { updatePostsFeed } from '../../hooks/usePostsFeed';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
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
import {
  ADMIN_POSTS_PAGE_SIZE,
  ADMIN_USERS_PAGE_SIZE,
  patchUserInPage,
  removePostFromPage,
  removeUserFromPage,
  type AdminPostsPage,
  type AdminUsersPage,
} from './adminPaging';
import styles from '../AdminPage.module.css';

type Tab = 'users' | 'posts' | 'announcements';

/** 用户列表查询（服务端分页 + 服务端搜索；key 含 page/q，翻页/改词即取）
 *  limit 显式带上：本地算页数用的是同一个常量，不能让服务端默认值改动后两边不一致 */
function loadAdminUsers(page: number, q: string) {
  return api
    .get('/admin/users', { params: { page, limit: ADMIN_USERS_PAGE_SIZE, q: q.trim() || undefined } })
    .then((res) => ({
      users: res.data.users as AdminUser[],
      total: res.data.total as number,
      totalPages: res.data.totalPages as number,
    }));
}

/** 帖子列表查询（服务端分页 + 服务端搜索；key 含 page/q，翻页/改词即取） */
function loadAdminPosts(postPage: number, q: string) {
  return api
    .get('/admin/posts', {
      params: { page: postPage, limit: ADMIN_POSTS_PAGE_SIZE, q: q.trim() || undefined },
    })
    .then((res) => ({
      posts: res.data.posts as AdminPost[],
      total: res.data.total as number,
      totalPages: res.data.totalPages as number,
    }));
}

/** 公告列表查询（announcements tab 展开时拉取，缓存常驻） */
function loadAdminAnnouncements() {
  return api.get('/admin/announcements').then((res) => res.data.announcements as AdminAnnouncement[]);
}

export default function AdminPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>('users');

  // Users state（搜索走服务端：输入即回到第 1 页，防抖后发请求）
  const [userSearch, setUserSearch] = useState('');
  const [userPage, setUserPage] = useState(1);
  const debouncedUserSearch = useDebouncedValue(userSearch, 300);

  /** 输入搜索词 → 立刻回到第 1 页（否则会停在旧页码上搜索，结果看起来是空的） */
  const handleUserSearch = (value: string) => {
    setUserSearch(value);
    setUserPage(1);
  };

  // Posts state（与用户列表同款：搜索走服务端，输入即回到第 1 页）
  const [postPage, setPostPage] = useState(1);
  const [postSearch, setPostSearch] = useState('');
  const debouncedPostSearch = useDebouncedValue(postSearch, 300);

  /** 输入搜索词 → 回到第 1 页（否则会停在旧页码上搜索，看起来像「搜不到」） */
  const handlePostSearch = (value: string) => {
    setPostSearch(value);
    setPostPage(1);
  };

  // Announcements state
  const [showSendForm, setShowSendForm] = useState(false);
  const [annTitle, setAnnTitle] = useState('');
  const [annContent, setAnnContent] = useState('');
  const [annTargetId, setAnnTargetId] = useState<number | null>(null);
  const [annTargetName, setAnnTargetName] = useState('');
  const [annSearch, setAnnSearch] = useState('');
  const [annSearchResults, setAnnSearchResults] = useState<AnnSearchResult[]>([]);
  const [showAnnDropdown, setShowAnnDropdown] = useState(false);
  const annDropdownRef = useRef<HTMLDivElement>(null);
  // 目标用户搜索：防抖定时器已由 useDebouncedValue 内部管理；此处仅保留
  // 请求序号守卫（作废选中/清除目标后的在途响应）与"选中后跳过"标记
  // （防抖值滞后一拍回落到 username 时不再发出搜索请求）
  const annSearchSeqRef = useRef(0);
  const skipAnnSearchRef = useRef(false);

  // Confirm dialog
  const [confirmAction, setConfirmAction] = useState<(() => void) | null>(null);
  const [confirmMsg, setConfirmMsg] = useState('');

  // Password change
  const [pwTarget, setPwTarget] = useState<AdminUser | null>(null);
  const [banTarget, setBanTarget] = useState<AdminUser | null>(null);
  const [newPw, setNewPw] = useState('');

  // Post detail（页面级渲染：切换 tab 时保持打开，与历史实现一致）
  const [selectedPostId, setSelectedPostId] = useState<number | null>(null);

  // ---- 三 tab 列表数据（§4.2：useQuery 取代手写 effect + 序号守卫）----
  const usersQuery = useQuery({
    queryKey: ['admin', 'users', userPage, debouncedUserSearch],
    queryFn: () =>
      loadAdminUsers(userPage, debouncedUserSearch).catch((err) => {
        showToast(getApiErrorMessage(err, '用户列表加载失败'));
        throw err;
      }),
    enabled: tab === 'users',
    // 翻页/改搜索词时先显示旧列表（与帖子管理一致），避免整块表格闪烁
    placeholderData: keepPreviousData,
  });
  const users = usersQuery.data?.users ?? [];
  const userTotalPages = usersQuery.data?.totalPages ?? 0;

  const postsQuery = useQuery({
    queryKey: ['admin', 'posts', postPage, debouncedPostSearch],
    queryFn: () =>
      loadAdminPosts(postPage, debouncedPostSearch).catch((err) => {
        showToast(getApiErrorMessage(err, '帖子列表加载失败'));
        throw err;
      }),
    enabled: tab === 'posts',
    placeholderData: keepPreviousData,
  });
  const posts = postsQuery.data?.posts ?? [];
  const postTotal = postsQuery.data?.totalPages ?? 0;

  const announcementsQuery = useQuery({
    queryKey: ['admin', 'announcements'],
    queryFn: () =>
      loadAdminAnnouncements().catch((err) => {
        showToast(getApiErrorMessage(err, '公告列表加载失败'));
        throw err;
      }),
    enabled: tab === 'announcements',
  });
  const announcements = announcementsQuery.data ?? [];

  const handleDeleteUser = (u: AdminUser) => {
    setConfirmMsg(`确定要删除用户 "${u.username}" 吗？该用户的帖子、评论等数据将一并删除。`);
    setConfirmAction(() => async () => {
      try {
        await api.delete(`/admin/users/${u.id}`);
        queryClient.setQueryData<AdminUsersPage>(['admin', 'users', userPage, debouncedUserSearch], (prev) =>
          prev ? removeUserFromPage(prev, u.id) : prev
        );
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
      const bannedUntil = new Date(Date.now() + days * 86400000).toISOString();
      queryClient.setQueryData<AdminUsersPage>(['admin', 'users', userPage, debouncedUserSearch], (prev) =>
        prev ? patchUserInPage(prev, banTarget.id, { banned_until: bannedUntil }) : prev
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
      queryClient.setQueryData<AdminUsersPage>(['admin', 'users', userPage, debouncedUserSearch], (prev) =>
        prev ? patchUserInPage(prev, u.id, { banned_until: null }) : prev
      );
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
        queryClient.setQueryData<AdminPostsPage>(['admin', 'posts', postPage, debouncedPostSearch], (prev) =>
          prev ? removePostFromPage(prev, p.id) : prev
        );
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
        queryClient.setQueryData<AdminAnnouncement[]>(['admin', 'announcements'], (prev) =>
          (prev ?? []).filter((x) => x.id !== a.id)
        );
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
      queryClient.invalidateQueries({ queryKey: ['admin', 'announcements'] });
    } catch {
      showToast('发送失败');
    }
  };

  // 搜索用户（debounce 300ms 自 useDebouncedValue 拆出，延迟不变，仅换实现方式）
  const handleAnnSearch = (value: string) => {
    setAnnSearch(value);
    setAnnTargetId(null);
    setAnnTargetName('');
    // 用户重新输入 → 恢复搜索（消费掉 selectAnnTarget/clearAnnTarget 的跳过标记）
    skipAnnSearchRef.current = false;
    if (!value.trim()) {
      setAnnSearchResults([]);
      setShowAnnDropdown(false);
      return;
    }
  };

  const debouncedAnnSearch = useDebouncedValue(annSearch, 300);
  // 防抖值非空时发起搜索，等价于原 setTimeout 回调（响应落地时带序号守卫，
  // 丢弃过期响应；跳过标记已由 selectAnnTarget/clearAnnTarget 置位时，
  // 防抖回落到选中值的那一拍不发出请求——选中/清除目标后不再触发旧搜索）
  useEffect(() => {
    if (skipAnnSearchRef.current) {
      skipAnnSearchRef.current = false;
      return;
    }
    const q = debouncedAnnSearch.trim();
    if (!q) return;
    const seq = ++annSearchSeqRef.current;
    api
      .get(`/admin/users/search?q=${encodeURIComponent(q)}`)
      .then((res) => {
        if (seq !== annSearchSeqRef.current) return; // 已有更新的搜索，丢弃过期响应
        setAnnSearchResults(res.data.users);
        setShowAnnDropdown(true);
      })
      .catch(() => {});
  }, [debouncedAnnSearch]);

  const selectAnnTarget = (u: { id: number; username: string }) => {
    setAnnTargetId(u.id);
    setAnnTargetName(u.username);
    setAnnSearch(u.username);
    setShowAnnDropdown(false);
    // 跳过防抖回落到 username 时触发的搜索，并作废仍在途的旧搜索响应
    skipAnnSearchRef.current = true;
    annSearchSeqRef.current++;
  };

  const clearAnnTarget = () => {
    setAnnTargetId(null);
    setAnnTargetName('');
    setAnnSearch('');
    setAnnSearchResults([]);
    setShowAnnDropdown(false);
    skipAnnSearchRef.current = true;
    annSearchSeqRef.current++;
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
            setUserSearch={handleUserSearch}
            userPage={userPage}
            setUserPage={setUserPage}
            userTotalPages={userTotalPages}
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
            setPostSearch={handlePostSearch}
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
