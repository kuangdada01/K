/**
 * ============================================================
 * 登录表单 (LoginForm)
 * ============================================================
 * 邮箱 + 密码登录；对应原 LoginPrompt 的 handleLogin 与其 JSX。
 * email/password/error/success/loading 均为受控字段，
 * 状态由 LoginPrompt 顶层持有（跨模式共享，切换模式不清空）。
 * ============================================================
 */

import type { FormEvent } from 'react';
import { useAuth } from '../../context/AuthContext';
import { getApiErrorMessage } from '../../api/http';
import type { Mode } from '../../hooks/useEmailVerification';
import styles from '../LoginPrompt.module.css';

interface LoginFormProps {
  email: string;
  password: string;
  error: string;
  success: string;
  loading: boolean;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  setError: (message: string) => void;
  setLoading: (loading: boolean) => void;
  onClose: () => void;
  onSwitchMode: (mode: Mode) => void;
}

export default function LoginForm({
  email,
  password,
  error,
  success,
  loading,
  onEmailChange,
  onPasswordChange,
  setError,
  setLoading,
  onClose,
  onSwitchMode,
}: LoginFormProps) {
  const { login } = useAuth();

  /** 登录提交 */
  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
      onClose();
    } catch (err) {
      setError(getApiErrorMessage(err, '登录失败'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <form className={styles.form} onSubmit={handleLogin}>
      {error && <div className={styles.error}>{error}</div>}
      {success && <div className={styles.success}>{success}</div>}
      <input
        className={styles.input}
        type="email"
        name="email"
        placeholder="邮箱"
        value={email}
        onChange={(e) => onEmailChange(e.target.value)}
        required
      />
      <input
        className={styles.input}
        type="password"
        name="password"
        placeholder="密码"
        value={password}
        onChange={(e) => onPasswordChange(e.target.value)}
        required
      />
      <button className={styles.button} type="submit" disabled={loading}>
        {loading ? '登录中...' : '登录'}
      </button>
      <div className={styles.actionsRow}>
        <button type="button" className={styles.registerLink} onClick={() => onSwitchMode('register')}>
          注册
        </button>
        <div className={styles.forgotRow}>
          <button type="button" className={styles.forgotLink} onClick={() => onSwitchMode('forgot')}>
            忘记密码？
          </button>
        </div>
      </div>
    </form>
  );
}
