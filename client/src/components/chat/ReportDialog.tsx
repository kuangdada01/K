/**
 * ============================================================
 * 举报消息对话框 (ReportDialog，2026-10-24)
 * ============================================================
 * 长按/右键消息 →「举报」后弹出的理由选择。
 *
 * 只给预设选项（不给自由文本框）：举报是给管理员看的信号，
 * 预设文案足够定位问题类型，也避免举报通道被当成聊天入口。
 */

import { useEffect, useState } from 'react';
import { Flag } from 'lucide-react';
import styles from './ReportDialog.module.css';

export const REPORT_REASONS = [
  { value: '恶意文件或诈骗', label: '恶意文件 / 诈骗' },
  { value: '垃圾广告', label: '垃圾广告' },
  { value: '骚扰或辱骂', label: '骚扰 / 辱骂' },
  { value: '其他', label: '其他' },
] as const;

interface ReportDialogProps {
  /** 被举报消息的摘要（文件名或正文前一段），只用于展示 */
  summary: string;
  onCancel: () => void;
  onSubmit: (reason: string) => void;
}

export default function ReportDialog({ summary, onCancel, onSubmit }: ReportDialogProps) {
  const [reason, setReason] = useState<string>(REPORT_REASONS[0].value);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className={styles.overlay} onClick={onCancel}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div className={styles.title}>
          <Flag size={18} />
          <span>举报这条消息</span>
        </div>
        <div className={styles.summary} title={summary}>
          {summary}
        </div>
        <div className={styles.options}>
          {REPORT_REASONS.map((r) => (
            <button
              key={r.value}
              type="button"
              className={`${styles.option} ${reason === r.value ? styles.active : ''}`}
              onClick={() => setReason(r.value)}
            >
              {r.label}
            </button>
          ))}
        </div>
        <div className={styles.actions}>
          <button type="button" className={styles.cancel} onClick={onCancel}>
            取消
          </button>
          <button type="button" className={styles.confirm} onClick={() => onSubmit(reason)}>
            举报
          </button>
        </div>
      </div>
    </div>
  );
}
