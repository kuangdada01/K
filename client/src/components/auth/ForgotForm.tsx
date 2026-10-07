/**
 * ============================================================
 * 忘记密码表单 (ForgotForm)
 * ============================================================
 * 邮箱验证码 + 新密码；对应原 LoginPrompt 的 handleResetPassword
 * 与其 JSX。字段均为受控，状态由 LoginPrompt 顶层持有
 * （跨模式共享，切换模式不清空）。
 *
 * 重置成功提示顺序（P1 修复，不可改动）：
 *   先 onSwitchMode('login')（内部会清 error/success），
 *   再 setSuccess('密码重置成功，请使用新密码登录')。
 * ============================================================
 */

import type { FormEvent } from 'react';
import { Send, Loader2 } from 'lucide-react';
import api from '../../api/http';
import { getApiErrorMessage } from '../../api/http';
import type { Mode } from '../../hooks/useEmailVerification';
import styles from '../LoginPrompt.module.css';

interface ForgotFormProps {
  email: string;
  password: string;
  confirmPassword: string;
  code: string;
  error: string;
  loading: boolean;
  sending: boolean;
  countdown: number;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onConfirmPasswordChange: (value: string) => void;
  onCodeChange: (value: string) => void;
  onSendCode: () => void;
  setError: (message: string) => void;
  setLoading: (loading: boolean) => void;
  setSuccess: (message: string) => void;
  onSwitchMode: (mode: Mode) => void;
}

export default function ForgotForm({
  email,
  password,
  confirmPassword,
  code,
  error,
  loading,
  sending,
  countdown,
  onEmailChange,
  onPasswordChange,
  onConfirmPasswordChange,
  onCodeChange,
  onSendCode,
  setError,
  setLoading,
  setSuccess,
  onSwitchMode,
}: ForgotFormProps) {
  /** 重置密码提交 */
  const handleResetPassword = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    if (password !== confirmPassword) {
      setError('两次密码不一致');
      return;
    }

    if (!code) {
      setError('请输入验证码');
      return;
    }

    setLoading(true);
    try {
      await api.post('/auth/reset-password', { email, code, password });
      onSwitchMode('login');
      setSuccess('密码重置成功，请使用新密码登录');
    } catch (err) {
      setError(getApiErrorMessage(err, '密码重置失败'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <form className={styles.form} onSubmit={handleResetPassword}>
      {error && <div className={styles.error}>{error}</div>}
      <div className={styles.emailRow}>
        <input
          className={styles.input}
          type="email"
          name="email"
          placeholder="邮箱"
          value={email}
          onChange={(e) => onEmailChange(e.target.value)}
          required
        />
        <button
          type="button"
          className={styles.sendBtn}
          onClick={onSendCode}
          disabled={sending || countdown > 0}
          title={countdown > 0 ? `${countdown}秒后可重发` : '发送验证码'}
        >
          {sending ? (
            <Loader2 size={14} className={styles.spin} />
          ) : countdown > 0 ? (
            <span className={styles.countdown}>{countdown}</span>
          ) : (
            <Send size={14} />
          )}
        </button>
      </div>
      <input
        className={styles.input}
        type="text"
        name="code"
        placeholder="验证码"
        value={code}
        onChange={(e) => onCodeChange(e.target.value)}
        maxLength={6}
        required
      />
      <input
        className={styles.input}
        type="password"
        name="new-password"
        placeholder="新密码"
        value={password}
        onChange={(e) => onPasswordChange(e.target.value)}
        required
      />
      <input
        className={styles.input}
        type="password"
        name="confirm-password"
        placeholder="确认新密码"
        value={confirmPassword}
        onChange={(e) => onConfirmPasswordChange(e.target.value)}
        required
      />
      <button className={styles.button} type="submit" disabled={loading}>
        {loading ? '重置中...' : '重置密码'}
      </button>
      <div className={styles.link}>
        想起密码了？{' '}
        <button type="button" className={styles.linkBtn} onClick={() => onSwitchMode('login')}>
          返回登录
        </button>
      </div>
    </form>
  );
}
