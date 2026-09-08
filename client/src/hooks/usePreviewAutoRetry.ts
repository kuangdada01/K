/**
 * ============================================================
 * 预览转码等待 Hook（hooks/usePreviewAutoRetry）
 * ============================================================
 * 发布界面 temp HTTP 预览通道（blob 失败兜底）配套：
 * HEVC/超规格 H.264 需要服务端转码，转码完成前预览必然失败；
 * 服务端转码完成后原地替换文件内容（同 URL），重新挂载 video 即可播放。
 *
 * 等待策略（有 pollStatus，推荐）：
 * - waiting=true 期间周期轮询状态接口，**done 才触发 retry()**
 *   （不会在转码未完成时反复重载）
 * - pending（转码中/排队）→ 间隔后继续轮询；error → 停止（手动重试兜底）
 * - 无 pollStatus：退化为盲重试（每隔 intervalMs 直接 retry 一次）
 *
 * ★ 生命周期解耦设计（关键）：
 *   等待链只由 waiting（调用方在"确认可播放"前保持 true）驱动——
 *   videoError 等失败信号翻转、metadata 成功等中间状态都不会杀死轮询链。
 *   只有真正可播放（canplay）时调用方置 waiting=false（并调 reset 复位计数）。
 *   此前实现用 failed 驱动链，video 元素在转码完成前加载触发 metadata 成功
 *   会清掉失败标记 → 链死 → 转码完成后再无自动恢复（表现为必须手动点重试）。
 * ============================================================
 */

import { useEffect, useRef } from 'react';

export type TempPreviewStatus = 'done' | 'pending' | 'error';

export interface UsePreviewAutoRetryOptions {
  /** 是否启用等待（temp HTTP 预览通道激活时） */
  active: boolean;
  /** 是否处于"等待转码完成"状态（确认可播放前保持 true；canplay 后置 false） */
  waiting: boolean;
  /** 执行一次重试：调用方在此重新挂载 video 元素（并清失败标记） */
  retry: () => void;
  /**
   * 查询预览就绪状态：done=可播放（触发 retry）；pending=继续等待；
   * error=永久失败（停止自动等待，保留手动重试）。缺省时退化为盲重试。
   */
  pollStatus?: () => Promise<TempPreviewStatus>;
  /** 等待间隔 ms（轮询/盲重试共用；默认 3000） */
  intervalMs?: number;
  /** 最大等待/重试次数，超出后停止（默认 240 ≈ 12 分钟，服务端串行转码上限） */
  maxRetries?: number;
}

/**
 * @returns reset —— 真正可播放（canplay）时调用：清定时器并复位等待计数
 */
export function usePreviewAutoRetry({
  active,
  waiting,
  retry,
  pollStatus,
  intervalMs = 3000,
  maxRetries = 240,
}: UsePreviewAutoRetryOptions): () => void {
  const timerRef = useRef<number | null>(null);
  const countRef = useRef(0);
  // 回调每次渲染后更新到 ref：等待链始终调用最新实现
  const callbacksRef = useRef({ retry, pollStatus });
  useEffect(() => {
    callbacksRef.current = { retry, pollStatus };
  });

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => {
    if (!active || !waiting) {
      // 通道未激活或已确认可播放：停链（计数由 reset() 显式复位）
      clearTimer();
      return;
    }
    clearTimer();
    if (countRef.current >= maxRetries) return; // 已耗尽：停（手动重试兜底）

    let alive = true;
    const stop = () => {
      alive = false;
      clearTimer();
    };
    const tick = () => {
      if (!alive || countRef.current >= maxRetries) return;
      countRef.current += 1;
      const { retry: doRetry, pollStatus: doPoll } = callbacksRef.current;
      if (!doPoll) {
        // 无状态接口：盲重试；waiting 保持 true 期间持续重试，
        // canplay（waiting=false）后由 effect 重跑停链
        doRetry();
        timerRef.current = window.setTimeout(tick, intervalMs);
        return;
      }
      doPoll()
        .then((st) => {
          if (!alive) return;
          if (st === 'done') {
            // 转码完成：重新挂载 video，并继续轮询直到 canplay（waiting=false）
            // 确认成功——重载失败（黑屏/挂起）时等待链不受影响，持续恢复
            doRetry();
            timerRef.current = window.setTimeout(tick, intervalMs);
          } else if (st === 'pending') {
            timerRef.current = window.setTimeout(tick, intervalMs);
          }
          // error：停止自动等待，保留手动"重试预览"按钮
        })
        .catch(() => {
          // 网络抖动：继续等待，不打断轮询链
          if (!alive) return;
          timerRef.current = window.setTimeout(tick, intervalMs);
        });
    };
    tick(); // 进入等待态立即查一次状态
    return stop;
  }, [active, waiting, intervalMs, maxRetries]);

  const reset = () => {
    clearTimer();
    countRef.current = 0;
  };
  return reset;
}
