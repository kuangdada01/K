/**
 * ============================================================
 * 管理后台 · 帖子管理 Tab (AdminPostsTab) —— 展示层
 * ============================================================
 * 状态与数据逻辑全部由 AdminPage（状态编排）持有并经 props 注入；
 * 本组件只负责帖子表格/搜索/分页的渲染。
 * （PostDetail 弹窗由 AdminPage 页面级渲染——切换 tab 时保持打开，
 * 与历史实现一致。）
 *
 * 搜索**不再本地过滤**：关键词经 props 回传给 AdminPage，由服务端
 * （/api/admin/posts?q=）过滤。本地过滤只看得到**当前这一页的 20 行**，
 * 于是搜一个不在当前页的帖子会得到空表 —— 那不是「没搜到」，是「搜不了」。
 * ============================================================
 */

import { Search, Trash2, ChevronLeft, ChevronRight } from 'lucide-react';
import { resolveMediaUrl, parseDbTime } from '../../utils';
import styles from '../AdminPage.module.css';
import type { AdminPost } from './types';

export interface AdminPostsTabProps {
  posts: AdminPost[];
  postSearch: string;
  setPostSearch: (v: string) => void;
  postPage: number;
  setPostPage: (updater: (p: number) => number) => void;
  postTotal: number;
  onDelete: (p: AdminPost) => void;
  onOpenDetail: (postId: number) => void;
}

export default function AdminPostsTab({
  posts,
  postSearch,
  setPostSearch,
  postPage,
  setPostPage,
  postTotal,
  onDelete,
  onOpenDetail,
}: AdminPostsTabProps) {
  return (
    <div>
      <div className={styles.toolbar}>
        <div className={styles.search}>
          <Search size={16} />
          <input
            name="search-posts"
            data-testid="admin-post-search"
            placeholder="搜索用户ID或用户名"
            value={postSearch}
            onChange={(e) => setPostSearch(e.target.value)}
          />
        </div>
      </div>
      <div className={styles.tableWrapper}>
        <table className={styles.table} data-testid="admin-posts-table">
          <thead>
            <tr>
              <th>用户ID</th>
              <th>图片</th>
              <th>作者</th>
              <th>描述</th>
              <th>发布时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {posts.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  data-testid="admin-posts-empty"
                  style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: 24 }}
                >
                  {postSearch.trim() ? '没有匹配的帖子' : '暂无帖子'}
                </td>
              </tr>
            )}
            {posts.map((p) => (
              <tr key={p.id}>
                <td>{p.user_id}</td>
                <td>
                  <img
                    src={resolveMediaUrl(p.video_cover || p.images?.[0] || p.image_url) || ''}
                    alt=""
                    data-testid="admin-post-thumb"
                    className={styles.postThumb}
                    style={{ cursor: 'pointer' }}
                    onClick={() => onOpenDetail(p.id)}
                  />
                </td>
                <td>{p.username}</td>
                <td className={styles.desc}>{p.description?.slice(0, 50) || '-'}</td>
                <td>{parseDbTime(p.created_at).toLocaleString()}</td>
                <td>
                  <button
                    className={`${styles.actionBtn} ${styles.del}`}
                    onClick={() => onDelete(p)}
                    title="删除帖子"
                  >
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
          <button
            data-testid="admin-posts-prev"
            disabled={postPage <= 1}
            onClick={() => setPostPage((p) => p - 1)}
            title="上一页"
          >
            <ChevronLeft size={16} />
          </button>
          <span data-testid="admin-posts-page">
            {postPage} / {postTotal}
          </span>
          <button
            data-testid="admin-posts-next"
            disabled={postPage >= postTotal}
            onClick={() => setPostPage((p) => p + 1)}
            title="下一页"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
