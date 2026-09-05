/**
 * ============================================================
 * 帖子九宫格 (ProfilePostGrid)
 * ============================================================
 * 个人主页的帖子/收藏/转发标签页与九宫格（纯展示组件）。
 */

import { Grid3X3, Bookmark, Repeat2, Heart, MessageCircle, Camera, Pin, Pencil, Trash2 } from 'lucide-react';
import type { Post } from '../../types';
import { resolveMediaUrl } from '../../utils';
import styles from './ProfilePostGrid.module.css';

interface ProfilePostGridProps {
  activeTab: 'posts' | 'bookmarks' | 'reposts';
  setActiveTab: (tab: 'posts' | 'bookmarks' | 'reposts') => void;
  isOwnProfile: boolean;
  posts: Post[];
  bookmarkedPosts: Post[];
  loadingBookmarks: boolean;
  repostedPosts: Post[];
  loadingReposts: boolean;
  onPostClick: (postId: number) => void;
  onEditPost: (post: Post, e: React.MouseEvent) => void;
  onDeletePost: (postId: number, e: React.MouseEvent) => void;
}

/** 单个帖子格 */
function PostGridItem({
  post,
  isOwnProfile,
  onPostClick,
  onEditPost,
  onDeletePost,
  showPin,
}: {
  post: Post;
  isOwnProfile: boolean;
  onPostClick: (postId: number) => void;
  onEditPost: (post: Post, e: React.MouseEvent) => void;
  onDeletePost: (postId: number, e: React.MouseEvent) => void;
  showPin: boolean;
}) {
  return (
    <div className={styles.item} onClick={() => onPostClick(post.id)}>
      {showPin && !!post.pinned && (
        <div className={styles.pinBadge}>
          <Pin size={24} fill="white" />
        </div>
      )}
      <img
        src={resolveMediaUrl(post.video_cover || post.images?.[0] || post.image_url) || ''}
        alt=""
        className={styles.image}
        // P10：九宫格全部懒加载，帖子多时不一次拉取几百张原图
        loading="lazy"
        decoding="async"
      />
      <div className={styles.overlay}>
        <span className={styles.stat}>
          <Heart size={18} fill="white" /> {post.like_count}
        </span>
        <span className={styles.stat}>
          <MessageCircle size={18} fill="white" /> {post.comment_count}
        </span>
      </div>
      {isOwnProfile && showPin && (
        <div className={styles.actions}>
          <button
            className={styles.edit}
            onClick={(e) => onEditPost(post, e)}
            title="编辑帖子"
            aria-label="编辑帖子"
          >
            <Pencil size={16} />
          </button>
          <button
            className={styles.delete}
            onClick={(e) => onDeletePost(post.id, e)}
            title="删除帖子"
            aria-label="删除帖子"
          >
            <Trash2 size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

export default function ProfilePostGrid({
  activeTab,
  setActiveTab,
  isOwnProfile,
  posts,
  bookmarkedPosts,
  loadingBookmarks,
  repostedPosts,
  loadingReposts,
  onPostClick,
  onEditPost,
  onDeletePost,
}: ProfilePostGridProps) {
  return (
    <div style={{ paddingTop: 0 }}>
      <div className={styles.tabs}>
        <button
          className={`${styles.tab} ${activeTab === 'posts' ? styles.active : ''}`}
          onClick={() => setActiveTab('posts')}
          aria-label="帖子"
        >
          <Grid3X3 size={24} />
        </button>
        {isOwnProfile && (
          <button
            className={`${styles.tab} ${activeTab === 'bookmarks' ? styles.active : ''}`}
            onClick={() => setActiveTab('bookmarks')}
            aria-label="收藏"
          >
            <Bookmark size={24} />
          </button>
        )}
        {isOwnProfile && (
          <button
            className={`${styles.tab} ${activeTab === 'reposts' ? styles.active : ''}`}
            onClick={() => setActiveTab('reposts')}
            aria-label="转发"
          >
            <Repeat2 size={24} />
          </button>
        )}
      </div>

      {activeTab === 'posts' ? (
        posts.length > 0 ? (
          <div className={styles.grid}>
            {posts.map((post) => (
              <PostGridItem
                key={post.id}
                post={post}
                isOwnProfile={isOwnProfile}
                showPin
                onPostClick={onPostClick}
                onEditPost={onEditPost}
                onDeletePost={onDeletePost}
              />
            ))}
          </div>
        ) : (
          <div className={styles.empty}>
            <Camera size={48} className={styles.emptyIcon} />
            <div className={styles.emptyText}>还没有帖子</div>
          </div>
        )
      ) : activeTab === 'bookmarks' ? (
        loadingBookmarks ? (
          <div className={styles.empty}>
            <div className={styles.emptyText}>加载中...</div>
          </div>
        ) : bookmarkedPosts.length > 0 ? (
          <div className={styles.grid}>
            {bookmarkedPosts.map((post) => (
              <PostGridItem
                key={post.id}
                post={post}
                isOwnProfile={isOwnProfile}
                showPin={false}
                onPostClick={onPostClick}
                onEditPost={onEditPost}
                onDeletePost={onDeletePost}
              />
            ))}
          </div>
        ) : (
          <div className={styles.empty}>
            <Bookmark size={48} className={styles.emptyIcon} />
            <div className={styles.emptyText}>还没有收藏</div>
          </div>
        )
      ) : loadingReposts ? (
        <div className={styles.empty}>
          <div className={styles.emptyText}>加载中...</div>
        </div>
      ) : repostedPosts.length > 0 ? (
        <div className={styles.grid}>
          {repostedPosts.map((post) => (
            <PostGridItem
              key={post.id}
              post={post}
              isOwnProfile={isOwnProfile}
              showPin={false}
              onPostClick={onPostClick}
              onEditPost={onEditPost}
              onDeletePost={onDeletePost}
            />
          ))}
        </div>
      ) : (
        <div className={styles.empty}>
          <Repeat2 size={48} className={styles.emptyIcon} />
          <div className={styles.emptyText}>还没有转发</div>
        </div>
      )}
    </div>
  );
}
