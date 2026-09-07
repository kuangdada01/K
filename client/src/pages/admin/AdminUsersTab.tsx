/**
 * ============================================================
 * 管理后台 · 用户管理 Tab (AdminUsersTab) —— 展示层
 * ============================================================
 * 状态与数据逻辑全部由 AdminPage（状态编排）持有并经 props 注入；
 * 本组件只负责用户列表/搜索框/封禁与改密弹窗的渲染。
 * ============================================================
 */

import { Search, Trash2, Key, Ban, CircleCheck } from 'lucide-react';
import styles from '../AdminPage.module.css';
import type { AdminUser } from './types';

export interface AdminUsersTabProps {
  users: AdminUser[];
  userSearch: string;
  setUserSearch: (v: string) => void;
  /** 行级封禁状态判定（逻辑在 AdminPage，与历史实现一致） */
  isBanned: (u: AdminUser) => boolean;
  onDelete: (u: AdminUser) => void;
  onUnban: (u: AdminUser) => void;
  onSetBanTarget: (u: AdminUser | null) => void;
  banTarget: AdminUser | null;
  onBan: (days: number) => void;
  pwTarget: AdminUser | null;
  setPwTarget: (u: AdminUser | null) => void;
  newPw: string;
  setNewPw: (v: string) => void;
  onChangePw: () => void;
}

export default function AdminUsersTab({
  users,
  userSearch,
  setUserSearch,
  isBanned,
  onDelete,
  onUnban,
  onSetBanTarget,
  banTarget,
  onBan,
  pwTarget,
  setPwTarget,
  newPw,
  setNewPw,
  onChangePw,
}: AdminUsersTabProps) {
  const filteredUsers = users.filter(
    (u) =>
      u.username.toLowerCase().includes(userSearch.toLowerCase()) ||
      u.email.toLowerCase().includes(userSearch.toLowerCase()) ||
      String(u.id).includes(userSearch)
  );

  return (
    <>
      <div>
        <div className={styles.toolbar}>
          <div className={styles.search}>
            <Search size={16} />
            <input
              placeholder="搜索用户名或邮箱"
              value={userSearch}
              onChange={(e) => setUserSearch(e.target.value)}
            />
          </div>
        </div>
        <div className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>ID</th>
                <th>用户名</th>
                <th>邮箱</th>
                <th>角色</th>
                <th>帖子数</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {filteredUsers.map((u) => (
                <tr key={u.id}>
                  <td>{u.id}</td>
                  <td>{u.username}</td>
                  <td>{u.email}</td>
                  <td>
                    <span className={`${styles.role} ${u.role}`}>
                      {u.role === 'admin' ? '管理员' : '用户'}
                    </span>
                    {isBanned(u) && (
                      <span className={`${styles.role} banned`} style={{ marginLeft: 4 }}>
                        封禁中·{u.banned_until!.slice(0, 10)}解封
                      </span>
                    )}
                  </td>
                  <td>{u.post_count}</td>
                  <td className={styles.actions}>
                    {u.role !== 'admin' &&
                      (isBanned(u) ? (
                        <button
                          className={`${styles.actionBtn} ${styles.pw}`}
                          onClick={() => onUnban(u)}
                          title="解封"
                        >
                          <CircleCheck size={16} />
                        </button>
                      ) : (
                        <button
                          className={`${styles.actionBtn} ${styles.del}`}
                          onClick={() => onSetBanTarget(u)}
                          title="封禁"
                        >
                          <Ban size={16} />
                        </button>
                      ))}
                    <button
                      className={`${styles.actionBtn} ${styles.pw}`}
                      onClick={() => setPwTarget(u)}
                      title="修改密码"
                    >
                      <Key size={16} />
                    </button>
                    <button
                      className={`${styles.actionBtn} ${styles.del}`}
                      onClick={() => onDelete(u)}
                      title="删除用户"
                    >
                      <Trash2 size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Password change modal */}
      {pwTarget && (
        <div className={styles.modalOverlay} onClick={() => setPwTarget(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3>修改 {pwTarget.username} 的密码</h3>
            <input
              type="password"
              placeholder="新密码（至少6位）"
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
            />
            <div className={styles.formActions}>
              <button className={styles.confirmBtn} onClick={onChangePw}>
                确认
              </button>
              <button
                className={styles.cancelBtn}
                onClick={() => {
                  setPwTarget(null);
                  setNewPw('');
                }}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Ban duration modal */}
      {banTarget && (
        <div className={styles.modalOverlay} onClick={() => onSetBanTarget(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3>封禁 {banTarget.username}</h3>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '4px 0 12px' }}>
              封禁期间该账号仅可浏览，无法发帖、评论、点赞、私信等
            </p>
            <div className={styles.formActions} style={{ gap: 8 }}>
              <button className={styles.confirmBtn} onClick={() => onBan(1)}>
                1天
              </button>
              <button className={styles.confirmBtn} onClick={() => onBan(7)}>
                1周
              </button>
              <button className={styles.confirmBtn} onClick={() => onBan(30)}>
                1月
              </button>
              <button className={styles.confirmBtn} onClick={() => onBan(365)}>
                1年
              </button>
              <button className={styles.cancelBtn} onClick={() => onSetBanTarget(null)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
