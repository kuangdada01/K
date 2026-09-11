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
 *
 * 搜索与分页都是**服务端**的（第 21 章）：
 * - 此前是「接口最多返回 500 行 + 这里本地过滤用户名」，粉丝超过上限的账号，
 *   那些粉丝在搜索框里根本不存在（搜不到 → 也关注/取关不了）；
 * - 现在搜索走 `?q=`（300ms 防抖），列表一次 20 条、底部「加载更多」按页追加。
 *   两者都在服务端做，所以**必须带上 page 参数**才会拿到分页形状的响应
 *   （不带 page 时服务端保持老客户端的 `{ users, has_more }` 形状）。
 * - 与老形状的差别只在响应字段：这里读 `totalPages` 决定还要不要显示「加载更多」。
 * ============================================================
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, Search } from 'lucide-react';
import api from '../../api/http';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
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

/** 每页条数（服务端上限 50；这里显式传，避免默认值改动后两边不一致） */
const PAGE_SIZE = 20;

export default function FollowersModal({ type, userId, onClose }: FollowersModalProps) {
  const navigate = useNavigate();
  const { setFollowStatus } = useFollow();
  const [users, setUsers] = useState<UserItem[]>([]);
  // loading 只用于「首次/切人」的占位；搜索或翻页时保留旧列表，避免整块闪一下
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [closing, setClosing] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const debouncedKeyword = useDebouncedValue(searchKeyword, 300);
  // 序号守卫：搜索词/翻页快速变化时丢弃过期响应（弹窗不走 react-query，手动守卫；
  // 否则慢的旧搜索会覆盖新的结果 —— 就是「搜索结果和输入框对不上」那类 bug）
  const seqRef = useRef(0);

  const endpoint = type === 'followers' ? '/friends/followers' : '/friends/following';
  const keyword = debouncedKeyword.trim();

  // 首次 + 搜索词变化 → 回到第 1 页重新取（搜索由服务端做）
  useEffect(() => {
    const seq = ++seqRef.current;
    api
      .get(`${endpoint}/${userId}`, {
        params: { page: 1, limit: PAGE_SIZE, q: keyword || undefined },
      })
      .then((res) => {
        if (seq !== seqRef.current) return; // 已有更新的请求，丢弃过期响应
        setUsers((res.data.users || []) as UserItem[]);
        setTotalPages((res.data.totalPages as number) ?? 0);
        setPage(1);
      })
      .catch(() => {
        if (seq === seqRef.current) showToast('加载失败');
      })
      .finally(() => {
        if (seq === seqRef.current) setLoading(false);
      });
  }, [endpoint, userId, keyword]);

  const hasMore = page < totalPages;

  const handleLoadMore = async () => {
    const next = page + 1;
    const seq = ++seqRef.current;
    setLoadingMore(true);
    try {
      const res = await api.get(`${endpoint}/${userId}`, {
        params: { page: next, limit: PAGE_SIZE, q: keyword || undefined },
      });
      if (seq !== seqRef.current) return;
      setUsers((prev) => [...prev, ...((res.data.users || []) as UserItem[])]);
      setTotalPages((res.data.totalPages as number) ?? 0);
      setPage(next);
    } catch {
      if (seq === seqRef.current) showToast('加载失败');
    } finally {
      if (seq === seqRef.current) setLoadingMore(false);
    }
  };

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
      setUsers((prev) => prev.map((u) => (u.id === targetId ? { ...u, is_following: 1 } : u)));
      showToast('ヾ(≧▽≦*)o关注成功！');
    } catch {
      showToast('关注失败');
    }
  };

  const handleUnfollow = async (targetId: number) => {
    try {
      await api.delete(`/friends/${targetId}`);
      setFollowStatus(targetId, false);
      setUsers((prev) => prev.map((u) => (u.id === targetId ? { ...u, is_following: 0 } : u)));
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

  return (
    <div className={`${styles.overlay} ${closing ? styles.closing : ''}`} onClick={handleClose}>
      <div
        className={`${styles.modal} ${closing ? styles.closing : ''}`}
        onClick={(e) => e.stopPropagation()}
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
            name="search-username"
            data-testid="followers-search"
            placeholder="搜索用户名"
            value={searchKeyword}
            onChange={(e) => setSearchKeyword(e.target.value)}
          />
        </div>

        <div className={styles.list} data-testid="followers-list">
          {loading ? (
            <div className={styles.empty}>加载中...</div>
          ) : users.length === 0 ? (
            <div className={styles.empty}>
              {searchKeyword.trim() ? '未找到相关用户' : type === 'followers' ? '暂无粉丝' : '暂无关注'}
            </div>
          ) : (
            users.map((user) => (
              <div
                key={user.id}
                className={styles.item}
                data-testid="follower-item"
                onClick={() => handleUserClick(user.id)}
              >
                <Avatar src={user.avatar} username={user.username} size={40} />
                <div className={styles.itemInfo}>
                  <div className={styles.itemName}>{user.username}</div>
                  {user.bio && <div className={styles.itemBio}>{user.bio}</div>}
                </div>
                {user.is_following ? (
                  <button
                    className={`${styles.btn} ${styles.following}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleUnfollow(user.id);
                    }}
                  >
                    已关注
                  </button>
                ) : (
                  <button
                    className={styles.btn}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleFollow(user.id);
                    }}
                  >
                    关注
                  </button>
                )}
              </div>
            ))
          )}
          {!loading && hasMore && (
            <button
              className={styles.loadMore}
              data-testid="followers-load-more"
              disabled={loadingMore}
              onClick={handleLoadMore}
            >
              {loadingMore ? '加载中...' : '加载更多'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
