/**
 * ============================================================
 * 推荐关注卡片 (RecommendCard)
 * ============================================================
 * 首页右侧推荐关注列表（纯展示组件，状态与动画由调用方控制）
 */

import { Link } from 'react-router-dom';
import { resolveMediaUrl } from '../utils';
import { saveHomeScrollPosition } from '../lib/scroll';
import styles from './RecommendCard.module.css';

export interface RecommendUser {
  id: number;
  username: string;
  avatar: string | null;
  bio?: string | null;
}

interface RecommendCardProps {
  users: RecommendUser[];
  removingIds: Set<number>;
  onFollow: (user: RecommendUser) => void;
}

export default function RecommendCard({ users, removingIds, onFollow }: RecommendCardProps) {
  return (
    <div className={styles.card}>
      <div className={styles.title}>推荐关注</div>
      <div className={styles.list}>
        {users.map((u) => (
          <div key={u.id} className={`${styles.item}${removingIds.has(u.id) ? ` ${styles.removing}` : ''}`}>
            <Link to={`/profile/${u.id}`} className={styles.itemLink} onClick={saveHomeScrollPosition}>
              {u.avatar ? (
                <img src={resolveMediaUrl(u.avatar) || ''} alt="" className={styles.itemAvatar} />
              ) : (
                <div className={styles.itemAvatarPlaceholder}>{u.username.charAt(0).toUpperCase()}</div>
              )}
              <div className={styles.itemInfo}>
                <div className={styles.itemName}>{u.username}</div>
                {u.bio && <div className={styles.itemBio}>{u.bio}</div>}
              </div>
            </Link>
            <button className={styles.followBtn} onClick={() => onFollow(u)}>
              关注
            </button>
          </div>
        ))}
        {users.length === 0 && <div className={styles.empty}>暂无推荐</div>}
      </div>
    </div>
  );
}
