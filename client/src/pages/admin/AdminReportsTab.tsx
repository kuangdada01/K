/**
 * ============================================================
 * 管理后台 · 举报管理 Tab (AdminReportsTab) —— 展示层
 * ============================================================
 * 状态与数据逻辑全部由 AdminPage（状态编排）持有并经 props 注入；
 * 本组件只负责举报表格/筛选/分页的渲染。
 *
 * 一行 = 一条私信举报：举报人 → 被举报人，消息摘要（正文 / 文件名 +
 * sha256 前 8 位 —— 同一个恶意包改名重发哈希相同，一眼看出惯犯），
 * 操作两个：删除消息（复用撤回语义，附件一并回收）/ 忽略（误报）。
 */

import { ChevronLeft, ChevronRight, EyeOff, Trash2 } from 'lucide-react';
import { parseDbTime } from '../../utils';
import styles from '../AdminPage.module.css';
import type { AdminReport } from './types';

export interface AdminReportsTabProps {
  reports: AdminReport[];
  /** open（默认，只看待处理）/ resolved / all */
  statusFilter: 'open' | 'resolved' | 'all';
  setStatusFilter: (s: 'open' | 'resolved' | 'all') => void;
  reportPage: number;
  setReportPage: (updater: (p: number) => number) => void;
  reportTotalPages: number;
  onDeleteMessage: (r: AdminReport) => void;
  onDismiss: (r: AdminReport) => void;
}

/** 消息摘要：文件名优先；已撤回的标出来（管理员要知道证据是否已被撤回销掉） */
function reportSummary(r: AdminReport): string {
  if (r.message_recalled_at) return '[已撤回]';
  if (r.message_file_name) return `📄 ${r.message_file_name}`;
  if (r.message_content) return r.message_content.slice(0, 40);
  return '[无内容]';
}

export default function AdminReportsTab({
  reports,
  statusFilter,
  setStatusFilter,
  reportPage,
  setReportPage,
  reportTotalPages,
  onDeleteMessage,
  onDismiss,
}: AdminReportsTabProps) {
  return (
    <div>
      <div className={styles.toolbar}>
        {/* 待处理优先：open 在前，管理员打开后台第一眼就是要干活的事 */}
        <div className={styles.filterGroup}>
          {(
            [
              ['open', '待处理'],
              ['resolved', '已处理'],
              ['all', '全部'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`${styles.filterBtn} ${statusFilter === value ? styles.filterActive : ''}`}
              onClick={() => setStatusFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.tableWrapper}>
        <table className={styles.table} data-testid="admin-reports-table">
          <thead>
            <tr>
              <th>举报时间</th>
              <th>举报人</th>
              <th>被举报人</th>
              <th>消息内容</th>
              <th>理由</th>
              <th>文件哈希</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {reports.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  data-testid="admin-reports-empty"
                  style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: 24 }}
                >
                  {statusFilter === 'open' ? '没有待处理的举报' : '暂无记录'}
                </td>
              </tr>
            )}
            {reports.map((r) => (
              <tr key={r.id}>
                <td>{parseDbTime(r.created_at).toLocaleString()}</td>
                <td>
                  {r.reporter_name}
                  <span className={styles.idHint}> #{r.reporter_id}</span>
                </td>
                <td>
                  {r.sender_name}
                  <span className={styles.idHint}> #{r.sender_id}</span>
                </td>
                <td className={styles.desc}>{reportSummary(r)}</td>
                <td>{r.reason || '-'}</td>
                {/* 只显前 8 位：定位惯犯够用，整串哈希只会把表格撑爆 */}
                <td style={{ fontFamily: 'monospace', fontSize: 12 }}>
                  {r.file_sha256 ? r.file_sha256.slice(0, 8) : '-'}
                </td>
                <td>
                  {r.status === 'open' ? (
                    <>
                      <button
                        className={`${styles.actionBtn} ${styles.del}`}
                        onClick={() => onDeleteMessage(r)}
                        title="删除被举报的消息（附件一并回收）"
                      >
                        <Trash2 size={16} />
                      </button>
                      <button className={styles.actionBtn} onClick={() => onDismiss(r)} title="忽略（误报）">
                        <EyeOff size={16} />
                      </button>
                    </>
                  ) : (
                    <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>已处理</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {reportTotalPages > 1 && (
        <div className={styles.pagination}>
          <button disabled={reportPage <= 1} onClick={() => setReportPage((p) => p - 1)} title="上一页">
            <ChevronLeft size={16} />
          </button>
          <span>
            {reportPage} / {reportTotalPages}
          </span>
          <button
            disabled={reportPage >= reportTotalPages}
            onClick={() => setReportPage((p) => p + 1)}
            title="下一页"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
