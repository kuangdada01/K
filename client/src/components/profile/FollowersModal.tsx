/**
 * ============================================================
 * 粉丝/关注列表弹窗 (FollowersModal)
 * ============================================================
 * 显示粉丝或关注用户列表的模态框
 *
 * 功能:
 * - 显示粉丝列表或关注列表
 * - 支持关注/取消关注操作
 * - 点击用户跳转到其主页
 * - 点击遮罩或按ESC关闭
 * ============================================================
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, Search } from 'lucide-react';
import api from '../../api/http';
import { useFollow } from '../../state/cache';
import { showToast } from '../ui/Toast';
import Avatar from '../ui/Avatar';
import styles from './FollowersModal.module.css';

interface UserItem {
  id: number;
  username: string;
  avatar: string | null;
  bio: string;
  is_following: number;
}

interface FollowersModalProps {
  type: 'followers' | 'following';
  userId: number;
  onClose: () => void;
}

export default function FollowersModal({ type, userId, onClose }: FollowersModalProps) {
  const navigate = useNavigate();
  const { setFollowStatus } = useFollow();
  const [users, setUsers] = useState<UserItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [closing, setClosing] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const endpoint = type === 'followers'
      ? `/friends/followers/${userId}`
      : `/friends/following/${userId}`;

    api.get(endpoint).then(res => {
      setUsers(res.data.users || []);
    }).catch(() => {
      showToast('加载失败');
    }).finally(() => setLoading(false));
  }, [type, userId]);

  // 关闭处理（定义在 effect 之前：effect 会引用它，且 useCallback 保证依赖稳定）
  const handleClose = useCallback(() => {
    setClosing(true);
    setTimeout(() => onClose(), 200);
  }, [onClose]);

  // ESC 键关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleClose]);

  const handleFollow = async (targetId: number) => {
    try {
      await api.post(`/friends/${targetId}`);
      setFollowStatus(targetId, true);
      setUsers(prev => prev.map(u => u.id === targetId ? { ...u, is_following: 1 } : u));
      showToast('ヾ(≧▽≦*)o关注成功！');
    } catch {
      showToast('关注失败');
    }
  };

  const handleUnfollow = async (targetId: number) => {
    try {
      await api.delete(`/friends/${targetId}`);
      setFollowStatus(targetId, false);
      setUsers(prev => prev.map(u => u.id === targetId ? { ...u, is_following: 0 } : u));
      showToast('o(TヘTo)取消关注成功！');
    } catch {
      showToast('取消关注失败');
    }
  };

  const handleUserClick = (targetId: number) => {
    handleClose();
    setTimeout(() => navigate(`/profile/${targetId}`), 250);
  };

  const title = type === 'followers' ? '粉丝' : '关注';

  const filteredUsers = searchKeyword.trim()
    ? users.filter(u => u.username.toLowerCase().includes(searchKeyword.trim().toLowerCase()))
    : users;

  return (
    <div className={`${styles.overlay} ${closing ? styles.closing : ''}`} onClick={handleClose}>
      <div
        className={`${styles.modal} ${closing ? styles.closing : ''}`}
        onClick={e => e.stopPropagation()}
      >
        <div className={styles.header}>
          <h3 className={styles.title}>{title}</h3>
          <button className={styles.close} data-back onClick={handleClose}>
            <X size={20} />
          </button>
        </div>

        <div className={styles.search}>
          <Search size={16} className={styles.searchIcon} />
          <input
            ref={searchInputRef}
            className={styles.searchInput}
            placeholder="搜索用户名"
            value={searchKeyword}
            onChange={e => setSearchKeyword(e.target.value)}
          />
        </div>

        <div className={styles.list}>
          {loading ? (
            <div className={styles.empty}>加载中...</div>
          ) : filteredUsers.length === 0 ? (
            <div className={styles.empty}>
              {searchKeyword.trim() ? '未找到相关用户' : (type === 'followers' ? '暂无粉丝' : '暂无关注')}
            </div>
          ) : (
            filteredUsers.map(user => (
              <div
                key={user.id}
                className={styles.item}
                onClick={() => handleUserClick(user.id)}
              >
                <Avatar src={user.avatar} username={user.username} size={40} />
                <div className={styles.itemInfo}>
                  <div className={styles.itemName}>{user.username}</div>
                  {user.bio && (
                    <div className={styles.itemBio}>{user.bio}</div>
                  )}
                </div>
                {user.is_following ? (
                  <button
                    className={`${styles.btn} ${styles.following}`}
                    onClick={e => { e.stopPropagation(); handleUnfollow(user.id); }}
                  >
                    已关注
                  </button>
                ) : (
                  <button
                    className={styles.btn}
                    onClick={e => { e.stopPropagation(); handleFollow(user.id); }}
                  >
                    关注
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
