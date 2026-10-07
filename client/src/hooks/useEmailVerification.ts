/**
 * ============================================================
 * 邮箱验证码发送 Hook (useEmailVerification)
 * ============================================================
 * 封装「发送验证码 + 60 秒倒计时 + interval 清理」逻辑：
 * - 邮箱非空校验 + 格式校验
 * - 按模式选择端点：forgot → /auth/forgot-password，其余 → /auth/send-code
 * - 发送成功后启动 60 秒倒计时，归零时自动清除 interval
 * - 组件卸载时清理 interval
 *
 * sending/countdown 状态由调用方（LoginPrompt 顶层）持有，
 * 保证跨模式切换时倒计时不重置（与原实现行为一致）。
 * ============================================================
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../api/http';
import { getApiErrorMessage } from '../api/http';

/** 弹窗模式（在此导出，供三个表单与 LoginPrompt 共用，避免循环依赖） */
export type Mode = 'login' | 'register' | 'forgot';

/**
 * 验证码发送 Hook
 *
 * @param mode 当前模式，决定请求端点（forgot 走忘记密码端点）
 * @param setError 错误提示 setter（由 LoginPrompt 顶层 error 状态提供）
 * @returns sending 发送中、countdown 剩余秒数、sendCode 发送函数（接收邮箱）
 */
export function useEmailVerification(mode: Mode, setError: (message: string) => void) {
  const [sending, setSending] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 倒计时清理
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  /** 发送验证码 */
  const sendCode = useCallback(
    async (email: string) => {
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
      } catch (err) {
        setError(getApiErrorMessage(err, '验证码发送失败'));
      } finally {
        setSending(false);
      }
    },
    [countdown, mode, setError]
  );

  return { sending, countdown, sendCode };
}
