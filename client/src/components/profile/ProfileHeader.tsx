/**
 * ============================================================
 * 个人主页头部 (ProfileHeader)
 * ============================================================
 * 头像/统计/简介 + 返回按钮 + 右上角头像二级菜单（主题/退出登录）
 * + 操作按钮（编辑资料/私密文件夹 或 关注/发信息）+ 资料编辑表单。
 * 纯展示组件，行为回调由 Profile 提供。
 */

import { RefObject, Dispatch, SetStateAction } from 'react';
import { ChevronLeft, UserCheck, UserPlus, MessageCircle } from 'lucide-react';
import type { User } from '../../types';
import Avatar from '../ui/Avatar';
import AvatarMenu from '../AvatarMenu';
import styles from './ProfileHeader.module.css';

interface ProfileHeaderProps {
  user: User;
  isOwnProfile: boolean;
  isEmbedded: boolean;
  postsCount: number;
  followersCount: number;
  followingCount: number;
  isFollowing: boolean;
  editing: boolean;
  username: string;
  bio: string;
  setUsername: Dispatch<SetStateAction<string>>;
  setBio: Dispatch<SetStateAction<string>>;
  onBack: () => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onAvatarUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onToggleEdit: () => void;
  onOpenPrivateFolder: () => void;
  onFollow: () => void;
  onMessage: () => void;
  onSaveProfile: () => void;
  onCancelEdit: () => void;
  onShowFollowers: () => void;
  onShowFollowing: () => void;
}

export default function ProfileHeader({
  user, isOwnProfile, isEmbedded, postsCount, followersCount, followingCount,
  isFollowing, editing, username, bio, setUsername, setBio,
  onBack, fileInputRef, onAvatarUpload, onToggleEdit, onOpenPrivateFolder,
  onFollow, onMessage, onSaveProfile, onCancelEdit, onShowFollowers, onShowFollowing,
}: ProfileHeaderProps) {
  return (
    <>
      {(!isOwnProfile || isEmbedded) && (
        <button className={styles.backBtn} data-back onClick={onBack} aria-label="返回">
          <ChevronLeft size={24} />
        </button>
      )}
      {isOwnProfile && !isEmbedded && (
        <div className={styles.avatarMenu}>
          <AvatarMenu iconMode placement="below" size={40} />
        </div>
      )}
      <div className={styles.header}>
        <div className={styles.avatarSection}>
          <Avatar
            src={user.avatar}
            username={user.username}
            size={150}
            className={styles.avatar}
            onClick={() => isOwnProfile && fileInputRef.current?.click()}
          />
          {isOwnProfile && (
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/jpg,image/png,image/gif,image/webp,image/avif,image/heic,image/heif"
              style={{ display: 'none' }}
              onChange={onAvatarUpload}
            />
          )}
        </div>

        <div className={styles.info}>
          <div className={styles.topRow}>
            <h2 className={styles.username}>{user.username}</h2>
          </div>

          <div className={styles.stats}>
            <span className={styles.stat}>
              <span className={styles.statCount}>{postsCount}</span> 帖子
            </span>
            <span className="profile-stat clickable" onClick={onShowFollowers}>
              <span className={styles.statCount}>{followersCount}</span> 粉丝
            </span>
            <span className="profile-stat clickable" onClick={onShowFollowing}>
              <span className={styles.statCount}>{followingCount}</span> 关注
            </span>
          </div>

          {user.bio && (
            <div className={styles.bio}>
              {user.bio}
            </div>
          )}
        </div>
      </div>

      {isOwnProfile ? (
        <div className={styles.actionBtns}>
          <button className={styles.editBtn} onClick={onToggleEdit}>
            编辑资料
          </button>
          <button className={styles.editBtn} onClick={onOpenPrivateFolder}>
            私密文件夹
          </button>
        </div>
      ) : (
        <div className={styles.actionBtns}>
          <button
            className={`${styles.followBtn} ${isFollowing ? styles.following : ''}`}
            onClick={onFollow}
          >
            {isFollowing ? <><UserCheck size={16} /> 已关注</> : <><UserPlus size={16} /> 关注</>}
          </button>
          <button className={styles.editBtn} onClick={onMessage}>
            <MessageCircle size={16} /> 发信息
          </button>
        </div>
      )}

      {editing && isOwnProfile && (
        <div className={styles.editForm}>
          <h3>编辑资料</h3>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>用户名</label>
            <input
              className={styles.formInput}
              value={username}
              onChange={e => setUsername(e.target.value)}
            />
          </div>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>简介</label>
            <textarea
              className={styles.formTextarea}
              value={bio}
              onChange={e => setBio(e.target.value)}
            />
          </div>
          <div className={styles.formActions}>
            <button className={styles.saveBtn} onClick={onSaveProfile}>保存</button>
            <button className={styles.cancelBtn} onClick={onCancelEdit}>取消</button>
          </div>
        </div>
      )}
    </>
  );
}
