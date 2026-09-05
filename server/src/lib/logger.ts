/**
 * ============================================================
 * 应用日志器（lib/logger）
 * ============================================================
 * 统一应用层日志为结构化 pino 输出，与 pino-http 请求日志保持一致：
 * - 生产环境输出 JSON
 * - 开发环境经 pino-pretty 可读化
 * - 测试环境不启用 transport（避免 pino-pretty worker 线程拖住 vitest 退出）
 * 替换原散落的 console.* 调用；info 及以上级别均输出。
 */

import pino from 'pino';
import { env } from '../config';

export const logger = pino({
  transport:
    env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } }
      : undefined,
});
