/**
 * ============================================================
 * 管理后台 (AdminPage)
 * ============================================================
 * 管理员专属页面，需要 admin 权限
 *
 * 功能:
 * - 用户管理: 查看用户列表、删除用户、重置密码
 * - 帖子管理: 查看帖子列表、删除帖子
 * - 公告管理: 创建公告（全局/定向）、删除公告
 * - 分页支持
 * ============================================================
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { updatePostsFeed } from '../hooks/usePostsFeed';
import {Users, FileText, Megaphone, Trash2, Key, Send, Search, ChevronLeft, ChevronRight, Ban, CircleCheck} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { showToast } from '../components/ui/Toast';
import PostDetail from '../components/post/PostDetail';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import api from '../api/http';
import { resolveMediaUrl, parseDbTime } from '../utils';
import styles from './AdminPage.module.css';

type Tab = 'users' | 'posts' | 'announcements';

interface AdminUser {
  id: number; username: string; email: string; avatar: string | null;
  bio: string; role: string; created_at: string; post_count: number;
  banned_until: string | null;
}

interface AdminPost {
  id: number; user_id: number; username: string; avatar: string | null;
  image_url: string; images: string[]; description: string; created_at: string;
  video_url?: string | null; video_cover?: string | null;
}

interface AdminAnnouncement {
  id: number; title: string; content: string; target_user_id: number | null;
  target_username: string | null; created_at: string;
}

export default function AdminPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
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
  const [annSearchResults, setAnnSearchResults] = useState<{ id: number; username: string; avatar: string | null }[]>([]);
  const [showAnnDropdown, setShowAnnDropdown] = useState(false);
  const annSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const annDropdownRef = useRef<HTMLDivElement>(null);

  // Confirm dialog
  const [confirmAction, setConfirmAction] = useState<(() => void) | null>(null);
  const [confirmMsg, setConfirmMsg] = useState('');

  // Password change
  const [pwTarget, setPwTarget] = useState<AdminUser | null>(null);
  const [banTarget, setBanTarget] = useState<AdminUser | null>(null);
  const [newPw, setNewPw] = useState('');

  // Post detail
  const [selectedPostId, setSelectedPostId] = useState<number | null>(null);

  useEffect(() => {
    if (user && user.role !== 'admin') {
      navigate('/');
    }
  }, [user, navigate]);

  useEffect(() => {
    // 数据加载内联在 effect 中（.then 回调内的 setState 属于异步回调，
    // 不触发 react-hooks/set-state-in-effect）
    if (tab === 'users') {
      api.get('/admin/users').then(res => setUsers(res.data.users)).catch(() => {});
    } else if (tab === 'posts') {
      api.get(`/admin/posts?page=${postPage}&limit=20`)
        .then(res => { setPosts(res.data.posts); setPostTotal(res.data.totalPages); })
        .catch(() => {});
    } else if (tab === 'announcements') {
      api.get('/admin/announcements').then(res => setAnnouncements(res.data.announcements)).catch(() => {});
    }
  }, [tab, postPage]);

  const loadAnnouncements = useCallback(async () => {
    try {
      const res = await api.get('/admin/announcements');
      setAnnouncements(res.data.announcements);
    } catch {}
  }, []);

  const handleDeleteUser = (u: AdminUser) => {
    setConfirmMsg(`确定要删除用户 "${u.username}" 吗？该用户的帖子、评论等数据将一并删除。`);
    setConfirmAction(() => async () => {
      try {
        await api.delete(`/admin/users/${u.id}`);
        setUsers(prev => prev.filter(x => x.id !== u.id));
        showToast('用户已删除');
      } catch { showToast('删除失败'); }
    });
  };

  // 封禁 / 解封
  const isBanned = (u: AdminUser) => !!u.banned_until && u.banned_until > new Date().toISOString();

  const handleBan = async (days: number) => {
    if (!banTarget) return;
    try {
      await api.post(`/admin/users/${banTarget.id}/ban`, { days });
      setUsers(prev => prev.map(x => x.id === banTarget.id ? { ...x, banned_until: new Date(Date.now() + days * 86400000).toISOString() } : x));
      showToast(`已封禁 ${banTarget.username}`);
      setBanTarget(null);
    } catch {
      showToast('封禁失败');
    }
  };

  const handleUnban = async (u: AdminUser) => {
    try {
      await api.post(`/admin/users/${u.id}/unban`);
      setUsers(prev => prev.map(x => x.id === u.id ? { ...x, banned_until: null } : x));
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
        setPosts(prev => prev.filter(x => x.id !== p.id));
        // 同步前台信息流缓存，删除后立即生效
        updatePostsFeed(queryClient, prev => prev.filter(x => x.id !== p.id));
        showToast('帖子已删除');
      } catch { showToast('删除失败'); }
    });
  };

  const handleDeleteAnn = (a: AdminAnnouncement) => {
    setConfirmMsg(`确定要删除公告 "${a.title}" 吗？`);
    setConfirmAction(() => async () => {
      try {
        await api.delete(`/admin/announcements/${a.id}`);
        setAnnouncements(prev => prev.filter(x => x.id !== a.id));
        showToast('公告已删除');
      } catch { showToast('删除失败'); }
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
    } catch { showToast('修改失败'); }
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
      setAnnTitle(''); setAnnContent(''); setAnnTargetId(null); setAnnTargetName(''); setAnnSearch('');
      setShowSendForm(false);
      loadAnnouncements();
    } catch { showToast('发送失败'); }
  };

  // 搜索用户（debounce）
  const handleAnnSearch = (value: string) => {
    setAnnSearch(value);
    setAnnTargetId(null);
    setAnnTargetName('');
    if (annSearchTimer.current) clearTimeout(annSearchTimer.current);
    if (!value.trim()) { setAnnSearchResults([]); setShowAnnDropdown(false); return; }
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

  const filteredUsers = users.filter(u =>
    u.username.toLowerCase().includes(userSearch.toLowerCase()) ||
    u.email.toLowerCase().includes(userSearch.toLowerCase()) ||
    String(u.id).includes(userSearch)
  );

  const filteredPosts = posts.filter(p =>
    p.username.toLowerCase().includes(postSearch.toLowerCase()) ||
    String(p.user_id).includes(postSearch)
  );

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>管理后台</h1>
      </div>

      <div className={styles.tabs}>
        <button className={`${styles.tab} ${tab === 'users' ? styles.active : ''}`} onClick={() => setTab('users')}>
          <Users size={18} /> 用户管理
        </button>
        <button className={`${styles.tab} ${tab === 'posts' ? styles.active : ''}`} onClick={() => setTab('posts')}>
          <FileText size={18} /> 帖子管理
        </button>
        <button className={`${styles.tab} ${tab === 'announcements' ? styles.active : ''}`} onClick={() => setTab('announcements')}>
          <Megaphone size={18} /> 公告管理
        </button>
      </div>

      <div >
        {/* Users Tab */}
        {tab === 'users' && (
          <div>
            <div className={styles.toolbar}>
              <div className={styles.search}>
                <Search size={16} />
                <input placeholder="搜索用户名或邮箱" value={userSearch} onChange={e => setUserSearch(e.target.value)} />
              </div>
            </div>
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>ID</th><th>用户名</th><th>邮箱</th><th>角色</th><th>帖子数</th><th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUsers.map(u => (
                    <tr key={u.id}>
                      <td>{u.id}</td>
                      <td>{u.username}</td>
                      <td>{u.email}</td>
                      <td>
                        <span className={`${styles.role} ${u.role}`}>{u.role === 'admin' ? '管理员' : '用户'}</span>
                        {isBanned(u) && <span className={`${styles.role} banned`} style={{ marginLeft: 4 }}>封禁中·{u.banned_until!.slice(0, 10)}解封</span>}
                      </td>
                      <td>{u.post_count}</td>
                      <td className={styles.actions}>
                        {u.role !== 'admin' && (isBanned(u) ? (
                          <button className={`${styles.actionBtn} ${styles.pw}`} onClick={() => handleUnban(u)} title="解封">
                            <CircleCheck size={16} />
                          </button>
                        ) : (
                          <button className={`${styles.actionBtn} ${styles.del}`} onClick={() => setBanTarget(u)} title="封禁">
                            <Ban size={16} />
                          </button>
                        ))}
                        <button className={`${styles.actionBtn} ${styles.pw}`} onClick={() => setPwTarget(u)} title="修改密码">
                          <Key size={16} />
                        </button>
                        <button className={`${styles.actionBtn} ${styles.del}`} onClick={() => handleDeleteUser(u)} title="删除用户">
                          <Trash2 size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Posts Tab */}
        {tab === 'posts' && (
          <div>
            <div className={styles.toolbar}>
              <div className={styles.search}>
                <Search size={16} />
                <input placeholder="搜索用户ID或用户名" value={postSearch} onChange={e => setPostSearch(e.target.value)} />
              </div>
            </div>
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>用户ID</th><th>图片</th><th>作者</th><th>描述</th><th>发布时间</th><th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPosts.map(p => (
                    <tr key={p.id}>
                      <td>{p.user_id}</td>
                      <td>
                        <img src={resolveMediaUrl(p.video_cover || p.images?.[0] || p.image_url) || ''} alt="" className={styles.postThumb} style={{ cursor: 'pointer' }} onClick={() => setSelectedPostId(p.id)} />
                      </td>
                      <td>{p.username}</td>
                      <td className={styles.desc}>{p.description?.slice(0, 50) || '-'}</td>
                      <td>{parseDbTime(p.created_at).toLocaleString()}</td>
                      <td>
                        <button className="${styles.actionBtn} ${styles.del}" onClick={() => handleDeletePost(p)} title="删除帖子">
                          <Trash2 size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {postTotal > 1 && (
              <div className={styles.pagination}>
                <button disabled={postPage <= 1} onClick={() => setPostPage(p => p - 1)}>
                  <ChevronLeft size={16} />
                </button>
                <span>{postPage} / {postTotal}</span>
                <button disabled={postPage >= postTotal} onClick={() => setPostPage(p => p + 1)}>
                  <ChevronRight size={16} />
                </button>
              </div>
            )}
          </div>
        )}

        {/* Announcements Tab */}
        {tab === 'announcements' && (
          <div>
            <div className={styles.toolbar}>
              <button className={styles.sendBtn} onClick={() => setShowSendForm(!showSendForm)}>
                <Send size={16} /> 发送公告
              </button>
            </div>
            {showSendForm && (
              <div className={styles.sendForm}>
                <input placeholder="公告标题" value={annTitle} onChange={e => setAnnTitle(e.target.value)} />
                <textarea placeholder="公告内容" value={annContent} onChange={e => setAnnContent(e.target.value)} rows={4} />
                <div className={styles.annWrapper} ref={annDropdownRef}>
                  <div className={styles.annInputRow}>
                    <Search size={16} />
                    <input
                      className={styles.annInput}
                      placeholder="搜索用户（输入用户名或ID）"
                      value={annSearch}
                      onChange={e => handleAnnSearch(e.target.value)}
                      onFocus={() => { if (annSearchResults.length > 0) setShowAnnDropdown(true); }}
                    />
                    {annTargetId && (
                      <button className={styles.annClear} onClick={clearAnnTarget}>×</button>
                    )}
                  </div>
                  {showAnnDropdown && annSearchResults.length > 0 && (
                    <div className={styles.annDropdown}>
                      {annSearchResults.map(u => (
                        <div key={u.id} className={styles.annItem} onClick={() => selectAnnTarget(u)}>
                          {u.avatar ? (
                            <img src={resolveMediaUrl(u.avatar) || ''} alt="" className={styles.annAvatar} />
                          ) : (
                            <div className={styles.annAvatarPlaceholder}>{u.username.charAt(0).toUpperCase()}</div>
                          )}
                          <span className={styles.annUsername}>{u.username}</span>
                          <span className={styles.annId}>#{u.id}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {!annTargetId && !annSearch && (
                    <div className={styles.annHint}>留空则发送给所有人</div>
                  )}
                  {annTargetId && (
                    <div className={styles.annSelected}>发送给: {annTargetName} (#{annTargetId})</div>
                  )}
                </div>
                <div className={styles.formActions}>
                  <button className={styles.confirmBtn} onClick={handleSendAnn}>发送</button>
                  <button className={styles.cancelBtn} onClick={() => setShowSendForm(false)}>取消</button>
                </div>
              </div>
            )}
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>ID</th><th>标题</th><th>内容</th><th>目标</th><th>时间</th><th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {announcements.map(a => (
                    <tr key={a.id}>
                      <td>{a.id}</td>
                      <td>{a.title}</td>
                      <td className={styles.desc}>{a.content.slice(0, 60)}</td>
                      <td>{a.target_username || '全体用户'}</td>
                      <td>{parseDbTime(a.created_at).toLocaleString()}</td>
                      <td>
                        <button className="${styles.actionBtn} ${styles.del}" onClick={() => handleDeleteAnn(a)} title="删除公告">
                          <Trash2 size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Password change modal */}
      {pwTarget && (
        <div className={styles.modalOverlay} onClick={() => setPwTarget(null)}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <h3>修改 {pwTarget.username} 的密码</h3>
            <input type="password" placeholder="新密码（至少6位）" value={newPw} onChange={e => setNewPw(e.target.value)} />
            <div className={styles.formActions}>
              <button className={styles.confirmBtn} onClick={handleChangePw}>确认</button>
              <button className={styles.cancelBtn} onClick={() => { setPwTarget(null); setNewPw(''); }}>取消</button>
            </div>
          </div>
        </div>
      )}

      {/* Ban duration modal */}
      {banTarget && (
        <div className={styles.modalOverlay} onClick={() => setBanTarget(null)}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <h3>封禁 {banTarget.username}</h3>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '4px 0 12px' }}>封禁期间该账号仅可浏览，无法发帖、评论、点赞、私信等</p>
            <div className={styles.formActions} style={{ gap: 8 }}>
              <button className={styles.confirmBtn} onClick={() => handleBan(1)}>1天</button>
              <button className={styles.confirmBtn} onClick={() => handleBan(7)}>1周</button>
              <button className={styles.confirmBtn} onClick={() => handleBan(30)}>1月</button>
              <button className={styles.confirmBtn} onClick={() => handleBan(365)}>1年</button>
              <button className={styles.cancelBtn} onClick={() => setBanTarget(null)}>取消</button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm dialog */}
      {confirmAction && (
        <ConfirmDialog
          message={confirmMsg}
          onConfirm={() => { confirmAction(); setConfirmAction(null); }}
          onCancel={() => setConfirmAction(null)}
        />
      )}

      {/* Post detail modal */}
      {selectedPostId && (
        <PostDetail postId={selectedPostId} onClose={() => setSelectedPostId(null)} />
      )}
    </div>
  );
}
