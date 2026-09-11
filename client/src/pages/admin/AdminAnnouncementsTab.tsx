/**
 * ============================================================
 * 管理后台 · 公告管理 Tab (AdminAnnouncementsTab) —— 展示层
 * ============================================================
 * 状态与数据逻辑全部由 AdminPage（状态编排）持有并经 props 注入；
 * 本组件只负责公告列表/发送表单/目标用户搜索下拉的渲染。
 * （公告表单/搜索状态跨 tab 切换保留——与历史实现一致。）
 * ============================================================
 */

import type { RefObject } from 'react';
import { Send, Search, Trash2, ChevronLeft, ChevronRight } from 'lucide-react';
import { resolveMediaUrl, parseDbTime } from '../../utils';
import styles from '../AdminPage.module.css';
import type { AdminAnnouncement } from './types';

export interface AnnSearchResult {
  id: number;
  username: string;
  avatar: string | null;
}

export interface AdminAnnouncementsTabProps {
  announcements: AdminAnnouncement[];
  /** 列表搜索与服务端分页（与「发送公告」表单里的目标用户搜索是两件事） */
  listSearch: string;
  setListSearch: (v: string) => void;
  listPage: number;
  setListPage: (updater: (p: number) => number) => void;
  listTotalPages: number;
  showSendForm: boolean;
  setShowSendForm: (v: boolean) => void;
  annTitle: string;
  setAnnTitle: (v: string) => void;
  annContent: string;
  setAnnContent: (v: string) => void;
  annTargetId: number | null;
  annTargetName: string;
  annSearch: string;
  annSearchResults: AnnSearchResult[];
  showAnnDropdown: boolean;
  setShowAnnDropdown: (v: boolean) => void;
  annDropdownRef: RefObject<HTMLDivElement | null>;
  onSearch: (value: string) => void;
  onSelectTarget: (u: AnnSearchResult) => void;
  onClearTarget: () => void;
  onSend: () => void;
  onDelete: (a: AdminAnnouncement) => void;
}

export default function AdminAnnouncementsTab({
  announcements,
  listSearch,
  setListSearch,
  listPage,
  setListPage,
  listTotalPages,
  showSendForm,
  setShowSendForm,
  annTitle,
  setAnnTitle,
  annContent,
  setAnnContent,
  annTargetId,
  annTargetName,
  annSearch,
  annSearchResults,
  showAnnDropdown,
  setShowAnnDropdown,
  annDropdownRef,
  onSearch,
  onSelectTarget,
  onClearTarget,
  onSend,
  onDelete,
}: AdminAnnouncementsTabProps) {
  return (
    <div>
      <div className={styles.toolbar}>
        <button className={styles.sendBtn} onClick={() => setShowSendForm(!showSendForm)}>
          <Send size={16} /> 发送公告
        </button>
        <div className={styles.search}>
          <Search size={16} />
          <input
            name="search-announcements"
            data-testid="admin-ann-search"
            placeholder="搜索标题/内容/目标用户名"
            value={listSearch}
            onChange={(e) => setListSearch(e.target.value)}
          />
        </div>
      </div>
      {showSendForm && (
        <div className={styles.sendForm}>
          <input
            name="ann-title"
            placeholder="公告标题"
            value={annTitle}
            onChange={(e) => setAnnTitle(e.target.value)}
          />
          <textarea
            placeholder="公告内容"
            value={annContent}
            onChange={(e) => setAnnContent(e.target.value)}
            rows={4}
          />
          <div className={styles.annWrapper} ref={annDropdownRef}>
            <div className={styles.annInputRow}>
              <Search size={16} />
              <input
                className={styles.annInput}
                name="ann-target-search"
                placeholder="搜索用户（输入用户名或ID）"
                value={annSearch}
                onChange={(e) => onSearch(e.target.value)}
                onFocus={() => {
                  if (annSearchResults.length > 0) setShowAnnDropdown(true);
                }}
              />
              {annTargetId && (
                <button className={styles.annClear} onClick={onClearTarget}>
                  ×
                </button>
              )}
            </div>
            {showAnnDropdown && annSearchResults.length > 0 && (
              <div className={styles.annDropdown}>
                {annSearchResults.map((u) => (
                  <div key={u.id} className={styles.annItem} onClick={() => onSelectTarget(u)}>
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
            {!annTargetId && !annSearch && <div className={styles.annHint}>留空则发送给所有人</div>}
            {annTargetId && (
              <div className={styles.annSelected}>
                发送给: {annTargetName} (#{annTargetId})
              </div>
            )}
          </div>
          <div className={styles.formActions}>
            <button className={styles.confirmBtn} onClick={onSend}>
              发送
            </button>
            <button className={styles.cancelBtn} onClick={() => setShowSendForm(false)}>
              取消
            </button>
          </div>
        </div>
      )}
      <div className={styles.tableWrapper}>
        <table className={styles.table} data-testid="admin-ann-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>标题</th>
              <th>内容</th>
              <th>目标</th>
              <th>时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {announcements.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  data-testid="admin-ann-empty"
                  style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: 24 }}
                >
                  {listSearch.trim() ? '没有匹配的公告' : '暂无公告'}
                </td>
              </tr>
            )}
            {announcements.map((a) => (
              <tr key={a.id}>
                <td>{a.id}</td>
                <td>{a.title}</td>
                <td className={styles.desc}>{a.content.slice(0, 60)}</td>
                <td>{a.target_username || '全体用户'}</td>
                <td>{parseDbTime(a.created_at).toLocaleString()}</td>
                <td>
                  <button
                    className={`${styles.actionBtn} ${styles.del}`}
                    onClick={() => onDelete(a)}
                    title="删除公告"
                  >
                    <Trash2 size={16} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {listTotalPages > 1 && (
        <div className={styles.pagination}>
          <button
            data-testid="admin-ann-prev"
            disabled={listPage <= 1}
            onClick={() => setListPage((p) => p - 1)}
            title="上一页"
          >
            <ChevronLeft size={16} />
          </button>
          <span data-testid="admin-ann-page">
            {listPage} / {listTotalPages}
          </span>
          <button
            data-testid="admin-ann-next"
            disabled={listPage >= listTotalPages}
            onClick={() => setListPage((p) => p + 1)}
            title="下一页"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
