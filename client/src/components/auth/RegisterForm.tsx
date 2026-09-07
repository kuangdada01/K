/**
 * ============================================================
 * 注册表单 (RegisterForm)
 * ============================================================
 * 用户名 + 邮箱验证码 + 密码 + 确认密码；对应原 LoginPrompt 的
 * handleRegister 与其 JSX。字段均为受控，状态由 LoginPrompt
 * 顶层持有（跨模式共享，切换模式不清空）。
 * ============================================================
 */

import type { FormEvent } from 'react';
import { Send, Loader2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { getApiErrorMessage } from '../../api/http';
import type { Mode } from '../../hooks/useEmailVerification';
import styles from '../LoginPrompt.module.css';

interface RegisterFormProps {
  username: string;
  email: string;
  password: string;
  confirmPassword: string;
  code: string;
  error: string;
  loading: boolean;
  sending: boolean;
  countdown: number;
  onUsernameChange: (value: string) => void;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onConfirmPasswordChange: (value: string) => void;
  onCodeChange: (value: string) => void;
  onSendCode: () => void;
  setError: (message: string) => void;
  setLoading: (loading: boolean) => void;
  onClose: () => void;
  onSwitchMode: (mode: Mode) => void;
}

export default function RegisterForm({
  username,
  email,
  password,
  confirmPassword,
  code,
  error,
  loading,
  sending,
  countdown,
  onUsernameChange,
  onEmailChange,
  onPasswordChange,
  onConfirmPasswordChange,
  onCodeChange,
  onSendCode,
  setError,
  setLoading,
  onClose,
  onSwitchMode,
}: RegisterFormProps) {
  const { register } = useAuth();

  /** 注册提交 */
  const handleRegister = async (e: FormEvent) => {
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
      await register(username, email, password, code);
      onClose();
    } catch (err) {
      setError(getApiErrorMessage(err, '注册失败'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <form className={styles.form} onSubmit={handleRegister}>
      {error && <div className={styles.error}>{error}</div>}
      <input
        className={styles.input}
        type="text"
        placeholder="用户名"
        value={username}
        onChange={(e) => onUsernameChange(e.target.value)}
        required
      />
      <div className={styles.emailRow}>
        <input
          className={styles.input}
          type="email"
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
        type="password"
        placeholder="密码"
        value={password}
        onChange={(e) => onPasswordChange(e.target.value)}
        required
      />
      <input
        className={styles.input}
        type="password"
        placeholder="确认密码"
        value={confirmPassword}
        onChange={(e) => onConfirmPasswordChange(e.target.value)}
        required
      />
      <input
        className={styles.input}
        type="text"
        placeholder="验证码"
        value={code}
        onChange={(e) => onCodeChange(e.target.value)}
        maxLength={6}
        required
      />
      <button className={styles.button} type="submit" disabled={loading}>
        {loading ? '注册中...' : '注册'}
      </button>
      <div className={styles.link}>
        已有账号？{' '}
        <button type="button" className={styles.linkBtn} onClick={() => onSwitchMode('login')}>
          返回登录
        </button>
      </div>
    </form>
  );
}
