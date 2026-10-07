/**
 * ============================================================
 * 登录/注册弹窗组件 (LoginPrompt)
 * ============================================================
 * 未登录用户尝试互动时弹出的登录/注册/忘记密码一体窗口。
 *
 * 本组件只承担：
 * - mode 状态与切换（switchMode 清 error/success，不清任何字段）
 * - closing 退场动画（200ms 后回调 onClose）
 * - 顶层共享字段状态（email/password 等跨模式共享，切换模式不清空）
 * - 组合 AuthModalShell + LoginForm/RegisterForm/ForgotForm
 *
 * 子模块：
 * - AuthModalShell: overlay/modal/ESC/关闭按钮（./auth/AuthModalShell）
 * - useEmailVerification: 验证码发送 + 60s 倒计时（../hooks/useEmailVerification）
 * - 三个表单: 各自提交逻辑与 JSX（./auth/LoginForm、RegisterForm、ForgotForm）
 * - fadeIn/scaleIn 动画（由 LoginPrompt.module.css 的 keyframes 提供）
 * ============================================================
 */

import { useCallback, useState } from 'react';
import { useEmailVerification, type Mode } from '../hooks/useEmailVerification';
import AuthModalShell from './auth/AuthModalShell';
import LoginForm from './auth/LoginForm';
import RegisterForm from './auth/RegisterForm';
import ForgotForm from './auth/ForgotForm';
import styles from './LoginPrompt.module.css';

interface LoginPromptProps {
  onClose: () => void;
}

export default function LoginPrompt({ onClose }: LoginPromptProps) {
  const [closing, setClosing] = useState(false);
  const [mode, setMode] = useState<Mode>('login');

  // 登录字段（email 跨模式共享）
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // 注册字段
  const [username, setUsername] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [code, setCode] = useState('');

  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  // 验证码发送 + 60s 倒计时（状态保持在顶层：切换模式时倒计时不重置）
  const { sending, countdown, sendCode } = useEmailVerification(mode, setError);

  const handleClose = useCallback(() => {
    if (closing) return;
    setClosing(true);
    setTimeout(onClose, 200);
  }, [closing, onClose]);

  /** 切换模式（清 error/success，不清任何字段） */
  const switchMode = (m: Mode) => {
    setMode(m);
    setError('');
    setSuccess('');
  };

  /** 发送验证码（email 由顶层持有，点击时传入当前值） */
  const handleSendCode = () => {
    void sendCode(email);
  };

  return (
    <AuthModalShell closing={closing} onClose={handleClose}>
      <h1 className={styles.authLogo}>k</h1>
      <p className={styles.authSubtitle}>
        {mode === 'login'
          ? '分享你的精彩瞬间'
          : mode === 'register'
            ? '注册后查看朋友的精彩内容'
            : '重置密码'}
      </p>

      {mode === 'login' ? (
        <LoginForm
          email={email}
          password={password}
          error={error}
          success={success}
          loading={loading}
          onEmailChange={setEmail}
          onPasswordChange={setPassword}
          setError={setError}
          setLoading={setLoading}
          onClose={handleClose}
          onSwitchMode={switchMode}
        />
      ) : mode === 'register' ? (
        <RegisterForm
          username={username}
          email={email}
          password={password}
          confirmPassword={confirmPassword}
          code={code}
          error={error}
          loading={loading}
          sending={sending}
          countdown={countdown}
          onUsernameChange={setUsername}
          onEmailChange={setEmail}
          onPasswordChange={setPassword}
          onConfirmPasswordChange={setConfirmPassword}
          onCodeChange={setCode}
          onSendCode={handleSendCode}
          setError={setError}
          setLoading={setLoading}
          onClose={handleClose}
          onSwitchMode={switchMode}
        />
      ) : (
        <ForgotForm
          email={email}
          password={password}
          confirmPassword={confirmPassword}
          code={code}
          error={error}
          loading={loading}
          sending={sending}
          countdown={countdown}
          onEmailChange={setEmail}
          onPasswordChange={setPassword}
          onConfirmPasswordChange={setConfirmPassword}
          onCodeChange={setCode}
          onSendCode={handleSendCode}
          setError={setError}
          setLoading={setLoading}
          setSuccess={setSuccess}
          onSwitchMode={switchMode}
        />
      )}
    </AuthModalShell>
  );
}
