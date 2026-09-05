/**
 * ============================================================
 * 登录/注册弹窗组件 (LoginPrompt)
 * ============================================================
 * 未登录用户尝试互动时弹出的登录/注册/忘记密码一体窗口
 *
 * 功能:
 * - 保持独立页面卡片样式，点击文字链接就地切换
 * - 登录: 邮箱 + 密码
 * - 注册: 用户名 + 邮箱验证码 + 密码
 * - 忘记密码: 邮箱验证码 + 新密码
 * - 支持 ESC 键关闭 / 点击遮罩关闭 / X 按钮关闭
 * - fadeIn/scaleIn 动画（由 LoginPrompt.module.css 的 keyframes 提供）
 * ============================================================
 */

import { useEffect, useState, useRef, useCallback } from 'react';
import { Send, Loader2, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import api from '../api/http';
import styles from './LoginPrompt.module.css';

interface LoginPromptProps {
  onClose: () => void;
}

type Mode = 'login' | 'register' | 'forgot';

export default function LoginPrompt({ onClose }: LoginPromptProps) {
  const { login, register } = useAuth();
  const [closing, setClosing] = useState(false);
  const [mode, setMode] = useState<Mode>('login');

  // 登录字段
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // 注册字段
  const [username, setUsername] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [code, setCode] = useState('');

  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const handleClose = useCallback(() => {
    if (closing) return;
    setClosing(true);
    setTimeout(onClose, 200);
  }, [closing, onClose]);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [handleClose]);

  // 倒计时清理
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  /** 切换模式 */
  const switchMode = (m: Mode) => {
    setMode(m);
    setError('');
    setSuccess('');
  };

  /** 发送验证码 */
  const handleSendCode = async () => {
    setError('');

    if (!email) {
      setError('请先输入邮箱地址');
      return;
    }

    // 简单校验邮箱格式
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('请输入有效的邮箱地址');
      return;
    }

    if (countdown > 0) return;

    setSending(true);
    try {
      if (mode === 'forgot') {
        await api.post('/auth/forgot-password', { email });
      } else {
        await api.post('/auth/send-code', { email });
      }
      // 启动60秒倒计时
      setCountdown(60);
      timerRef.current = setInterval(() => {
        setCountdown((prev) => {
          if (prev <= 1) {
            if (timerRef.current) clearInterval(timerRef.current);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    } catch (err: any) {
      setError(err.response?.data?.error || '验证码发送失败');
    } finally {
      setSending(false);
    }
  };

  /** 登录提交 */
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
      handleClose();
    } catch (err: any) {
      setError(err.response?.data?.error || '登录失败');
    } finally {
      setLoading(false);
    }
  };

  /** 注册提交 */
  const handleRegister = async (e: React.FormEvent) => {
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
      handleClose();
    } catch (err: any) {
      setError(err.response?.data?.error || '注册失败');
    } finally {
      setLoading(false);
    }
  };

  /** 重置密码提交 */
  const handleResetPassword = async (e: React.FormEvent) => {
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
      setSuccess('密码重置成功，请使用新密码登录');
      switchMode('login');
    } catch (err: any) {
      setError(err.response?.data?.error || '密码重置失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className={`${styles.overlay}${closing ? ` ${styles.closing}` : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        handleClose();
      }}
    >
      <div
        className={`${styles.modal}${closing ? ` ${styles.closing}` : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <button className={styles.close} data-back onClick={handleClose}>
          <X size={18} />
        </button>

        <h1 className={styles.authLogo}>k</h1>
        <p className={styles.authSubtitle}>
          {mode === 'login'
            ? '分享你的精彩瞬间'
            : mode === 'register'
              ? '注册后查看朋友的精彩内容'
              : '重置密码'}
        </p>

        {mode === 'login' ? (
          <form className={styles.form} onSubmit={handleLogin}>
            {error && <div className={styles.error}>{error}</div>}
            {success && <div className={styles.success}>{success}</div>}
            <input
              className={styles.input}
              type="email"
              placeholder="邮箱"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <input
              className={styles.input}
              type="password"
              placeholder="密码"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <button className={styles.button} type="submit" disabled={loading}>
              {loading ? '登录中...' : '登录'}
            </button>
            <div className={styles.actionsRow}>
              <button type="button" className={styles.registerLink} onClick={() => switchMode('register')}>
                注册
              </button>
              <div className={styles.forgotRow}>
                <button type="button" className={styles.forgotLink} onClick={() => switchMode('forgot')}>
                  忘记密码？
                </button>
              </div>
            </div>
          </form>
        ) : mode === 'register' ? (
          <form className={styles.form} onSubmit={handleRegister}>
            {error && <div className={styles.error}>{error}</div>}
            <input
              className={styles.input}
              type="text"
              placeholder="用户名"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
            <div className={styles.emailRow}>
              <input
                className={styles.input}
                type="email"
                placeholder="邮箱"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
              <button
                type="button"
                className={styles.sendBtn}
                onClick={handleSendCode}
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
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <input
              className={styles.input}
              type="password"
              placeholder="确认密码"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
            />
            <input
              className={styles.input}
              type="text"
              placeholder="验证码"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              maxLength={6}
              required
            />
            <button className={styles.button} type="submit" disabled={loading}>
              {loading ? '注册中...' : '注册'}
            </button>
            <div className={styles.link}>
              已有账号？{' '}
              <button type="button" className={styles.linkBtn} onClick={() => switchMode('login')}>
                返回登录
              </button>
            </div>
          </form>
        ) : (
          <form className={styles.form} onSubmit={handleResetPassword}>
            {error && <div className={styles.error}>{error}</div>}
            <div className={styles.emailRow}>
              <input
                className={styles.input}
                type="email"
                placeholder="邮箱"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
              <button
                type="button"
                className={styles.sendBtn}
                onClick={handleSendCode}
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
              placeholder="验证码"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              maxLength={6}
              required
            />
            <input
              className={styles.input}
              type="password"
              placeholder="新密码"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <input
              className={styles.input}
              type="password"
              placeholder="确认新密码"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
            />
            <button className={styles.button} type="submit" disabled={loading}>
              {loading ? '重置中...' : '重置密码'}
            </button>
            <div className={styles.link}>
              想起密码了？{' '}
              <button type="button" className={styles.linkBtn} onClick={() => switchMode('login')}>
                返回登录
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
