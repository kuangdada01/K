/**
 * ============================================================
 * 文件上传队列 Hook（features/messages/hooks）
 * ============================================================
 * 私信文件的"选完就传"，一条队列、逐个上传（不并发）：
 *
 *  · **进度**：axios 的 onUploadProgress 给到 0–100%，进度条直接读；
 *  · **串行**：一次选 9 个 100MB 的文件，并发会把上行带宽切成 9 份、
 *    每个都慢慢爬 —— 串行至少让第一个尽快到达；
 *  · **失败留在托盘里**：错误文案用服务端的 `error`（"文件不能超过 100MB"、
 *    "不支持该文件类型"），点「重试」用同一个 File 对象再传一次，不用重选；
 *  · **切会话即作废**：纪元 +1 后在途请求 abort，迟到的响应不许落到新会话里
 *    （与 useMessages 的 sessionEpoch 同一个套路）。
 *
 * 上传成功不在这里插消息：交给调用方的 onSent（走 useMessages.appendMessage），
 * 这样消息列表的合并规则只有一处。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import api, { getApiErrorMessage } from '../../../api/http';
import { MAX_FILES_PER_SEND, MAX_FILE_BYTES, isAllowedMessageFile, toMB } from '@k/shared';
import { showToast } from '../../../components/ui/Toast';
import type { Message } from '../../../types';

export type UploadStatus = 'uploading' | 'failed';

export interface UploadItem {
  id: string;
  name: string;
  size: number;
  /** 0–100（失败时停在最后的位置，方便看出传到哪一步断的） */
  progress: number;
  status: UploadStatus;
  /** 失败原因（服务端文案优先） */
  error: string | null;
}

export interface UseFileUploadOptions {
  /** 当前会话对端 id；null = 不在会话页（忽略选择） */
  partnerId: number | null;
  /** 上传成功：把服务端返回的消息插进列表 */
  onSent: (message: Message) => void;
  /** 会话列表/角标刷新（共享 store 单飞） */
  refreshConversations: () => Promise<void>;
}

let uploadSeq = 0;

export function useFileUpload({ partnerId, onSent, refreshConversations }: UseFileUploadOptions) {
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  /** 本地 id → File：重试要用**同一个 File 对象**，重新从 input 取会拿不到 */
  const filesRef = useRef(new Map<string, File>());
  /** 会话纪元：切换会话 +1，在途请求的迟到响应据此丢弃 */
  const epochRef = useRef(0);
  /** 在途请求的中止句柄（切会话/卸载/关闭托盘项时 abort，别白耗流量） */
  const abortRef = useRef(new Map<string, AbortController>());
  /** 当前会话 id 的镜像（uploadOne 在队列里跑，读 state 会拿到旧值） */
  const partnerIdRef = useRef<number | null>(partnerId);

  useEffect(() => {
    partnerIdRef.current = partnerId;
    epochRef.current += 1;
    // 切会话：在途作废 + 托盘清空（切回来不会再看到上一个会话的上传）
    for (const controller of abortRef.current.values()) controller.abort();
    abortRef.current.clear();
    filesRef.current.clear();
    // 清托盘走宏任务：避开 react-hooks/set-state-in-effect（与 useChatActions
    // 切会话清引用预览同一手法；首挂载时 items 已是空数组，clear 是 no-op）
    const timer = setTimeout(() => setUploads([]), 0);
    return () => clearTimeout(timer);
  }, [partnerId]);

  // 卸载：中止在途请求（避免 setState on unmounted）
  useEffect(() => {
    const controllers = abortRef.current;
    return () => {
      epochRef.current += 1;
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
    };
  }, []);

  const patch = useCallback((id: string, next: Partial<UploadItem>) => {
    setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, ...next } : u)));
  }, []);

  const remove = useCallback((id: string) => {
    filesRef.current.delete(id);
    setUploads((prev) => prev.filter((u) => u.id !== id));
  }, []);

  /** 真正的上传动作（首次与重试共用） */
  const uploadOne = useCallback(
    async (id: string, file: File) => {
      const epoch = epochRef.current;
      const receiverId = partnerIdRef.current;
      if (receiverId === null) return;

      const controller = new AbortController();
      abortRef.current.set(id, controller);
      patch(id, { status: 'uploading', progress: 0, error: null });

      try {
        const form = new FormData();
        form.append('receiverId', String(receiverId));
        // 第三参数显式给文件名：否则部分浏览器会用 blob 的默认名（"blob"）
        form.append('file', file, file.name);
        const res = await api.post('/messages', form, {
          headers: { 'Content-Type': 'multipart/form-data' },
          // 大文件不能吃 15s 的全局超时（默认值会直接把上传掐断）
          timeout: 0,
          signal: controller.signal,
          onUploadProgress: (event) => {
            const total = event.total ?? file.size;
            if (!total) return;
            const percent = Math.min(100, Math.round((event.loaded / total) * 100));
            patch(id, { progress: percent });
          },
        });
        // 会话已切换：结果作废（消息不插、托盘早已清空）
        if (epoch !== epochRef.current) return;
        onSent(res.data as Message);
        remove(id);
        void refreshConversations().catch(() => {});
      } catch (err) {
        if (epoch !== epochRef.current) return;
        // 主动取消（切会话/卸载）不算失败
        if ((err as { code?: string })?.code === 'ERR_CANCELED') return;
        patch(id, {
          status: 'failed',
          error: getApiErrorMessage(err, '文件发送失败，请重试'),
        });
      } finally {
        abortRef.current.delete(id);
      }
    },
    [onSent, patch, refreshConversations, remove]
  );

  /**
   * 选完文件后入队。
   *
   * 校验顺序：数量 → 大小 → 类型（与服务端同一份白名单）。不合法的不入队，
   * 直接 toast 说清是哪一条为什么没发出去 —— 静默丢弃是这类功能最常见的投诉点。
   */
  const enqueueFiles = useCallback(
    (picked: FileList | File[]) => {
      if (partnerIdRef.current === null) return;
      const files = Array.from(picked);
      if (files.length === 0) return;

      let list = files;
      if (list.length > MAX_FILES_PER_SEND) {
        showToast(`一次最多发送 ${MAX_FILES_PER_SEND} 个文件，多出的已忽略`);
        list = list.slice(0, MAX_FILES_PER_SEND);
      }

      const accepted: File[] = [];
      const rejected: string[] = [];
      for (const file of list) {
        if (file.size <= 0) {
          rejected.push(`${file.name} 是空文件`);
          continue;
        }
        if (file.size > MAX_FILE_BYTES) {
          rejected.push(`${file.name} 超过 ${toMB(MAX_FILE_BYTES)}MB`);
          continue;
        }
        if (!isAllowedMessageFile(file.name)) {
          rejected.push(`${file.name} 的类型不支持`);
          continue;
        }
        accepted.push(file);
      }
      // 多个被拒时只弹第一条详情，后面用「等 N 个」收尾（toast 放不下长列表）
      if (rejected.length === 1) showToast(rejected[0]!);
      else if (rejected.length > 1) showToast(`${rejected[0]} 等 ${rejected.length} 个文件未发送`);
      if (accepted.length === 0) return;

      const next: UploadItem[] = accepted.map((file) => ({
        id: `u${Date.now()}-${++uploadSeq}`,
        name: file.name,
        size: file.size,
        progress: 0,
        status: 'uploading' as const,
        error: null,
      }));
      for (let i = 0; i < next.length; i += 1) filesRef.current.set(next[i]!.id, accepted[i]!);
      setUploads((prev) => [...prev, ...next]);

      // 串行：上一个的请求结束（成功/失败）再发下一个
      void (async () => {
        for (let i = 0; i < next.length; i += 1) {
          const file = accepted[i];
          const item = next[i];
          // 入队后又被用户关掉 → 不再上传
          if (!file || !item || !filesRef.current.has(item.id)) continue;
          await uploadOne(item.id, file);
        }
      })();
    },
    [uploadOne]
  );

  /** 失败重试：同一份 File 再传一次 */
  const retryUpload = useCallback(
    (id: string) => {
      const file = filesRef.current.get(id);
      if (!file) {
        remove(id);
        return;
      }
      void uploadOne(id, file);
    },
    [remove, uploadOne]
  );

  /** 关掉托盘里的某一条（在途的直接 abort，失败项不再占位） */
  const dismissUpload = useCallback(
    (id: string) => {
      abortRef.current.get(id)?.abort();
      abortRef.current.delete(id);
      remove(id);
    },
    [remove]
  );

  return { uploads, enqueueFiles, retryUpload, dismissUpload };
}
