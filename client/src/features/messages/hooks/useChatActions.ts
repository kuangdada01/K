/**
 * ============================================================
 * 聊天操作 Hook（features/messages/hooks）
 * ============================================================
 * 自 Messages.tsx 拆出：发送文字/图片、清除会话确认、复制/引用/
 * 撤回、滚动定位到原消息。全部行为与原内联实现一致（含 toast 文案、
 * 纪元守卫、滚动到底部等）。
 */

import { useCallback, useEffect, useState } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import api from '../../../api/http';
import { MAX_IMAGE_BYTES, toMB } from '@k/shared';
import { showToast } from '../../../components/ui/Toast';
import bubbleStyles from '../../../components/chat/MessageBubble.module.css';
import type { Conversation, Message } from '../../../types';

export interface UseChatActionsOptions {
  selectedPartner: Conversation | null;
  messages: Message[];
  sessionEpochRef: MutableRefObject<number>;
  chatMessagesRef: RefObject<HTMLDivElement | null>;
  chatInputRef: RefObject<HTMLInputElement | null>;
  imageInputRef: RefObject<HTMLInputElement | null>;
  /** 会话/通知刷新（共享收件箱 store 的单飞请求，见 state/inboxStore） */
  refreshConversations: () => Promise<void>;
  onAppend: (m: Message) => void;
  onRemove: (id: number) => void;
  onClearLocal: () => void;
  /** 上下文菜单关闭（复制/引用/撤回后收起菜单） */
  closeMenu: () => void;
}

export function useChatActions({
  selectedPartner,
  messages,
  sessionEpochRef,
  chatMessagesRef,
  chatInputRef,
  imageInputRef,
  refreshConversations,
  onAppend,
  onRemove,
  onClearLocal,
  closeMenu,
}: UseChatActionsOptions) {
  const [sending, setSending] = useState(false);
  const [quoteMsg, setQuoteMsg] = useState<Message | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  // §5.2：切换会话后清空引用预览，避免跨会话残留。
  // setState 经 setTimeout 宏任务触发，避开 react-hooks/set-state-in-effect；
  // 首次挂载时 quoteMsg 已是 null，setQuoteMsg(null) 为 no-op
  useEffect(() => {
    const timer = setTimeout(() => setQuoteMsg(null), 0);
    return () => clearTimeout(timer);
  }, [selectedPartner?.partner_id]);

  const handleClearMessages = () => {
    if (!selectedPartner) return;
    setShowClearConfirm(true);
  };

  const confirmClearMessages = async () => {
    if (!selectedPartner) return;
    try {
      await api.delete(`/messages/${selectedPartner.partner_id}`);
      onClearLocal();
      // 走共享 store 的单飞请求（此前这里又直接 GET 了一次会话列表）
      await refreshConversations();
    } catch {
      showToast('清除失败');
    }
    setShowClearConfirm(false);
  };

  const handleSend = async (text: string) => {
    const content = text.trim();
    if (!content || !selectedPartner || sending) return;
    const epoch = sessionEpochRef.current;
    setSending(true);
    try {
      const payload: Record<string, unknown> = {
        receiverId: selectedPartner.partner_id,
        content,
      };
      if (quoteMsg) {
        payload.quotedMessageId = quoteMsg.id;
      }
      const res = await api.post('/messages', payload);
      if (epoch !== sessionEpochRef.current) return;
      onAppend(res.data);
      setQuoteMsg(null);
      requestAnimationFrame(() => {
        const el = chatMessagesRef.current;
        if (el) el.scrollTop = 0; // column-reverse: 0 = 底部
      });
    } catch {
      showToast('发送失败');
    } finally {
      setSending(false);
    }
  };

  const handleSendImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedPartner || sending) return;

    // 检查图片大小（上限见 @k/shared MAX_IMAGE_BYTES）
    if (file.size > MAX_IMAGE_BYTES) {
      showToast(`图片超过${toMB(MAX_IMAGE_BYTES)}MB限制`);
      if (imageInputRef.current) imageInputRef.current.value = '';
      return;
    }

    const epoch = sessionEpochRef.current;
    setSending(true);
    try {
      const formData = new FormData();
      formData.append('receiverId', String(selectedPartner.partner_id));
      formData.append('image', file);
      const res = await api.post('/messages', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      if (epoch !== sessionEpochRef.current) return;
      onAppend(res.data);
      requestAnimationFrame(() => {
        const el = chatMessagesRef.current;
        if (el) el.scrollTop = 0; // column-reverse: 0 = 底部
      });
    } catch {
      showToast('图片发送失败');
    } finally {
      setSending(false);
      if (imageInputRef.current) imageInputRef.current.value = '';
    }
  };

  // 复制消息
  const handleCopy = useCallback(
    (msgId: number) => {
      const msg = messages.find((m) => m.id === msgId);
      if (!msg) return;
      navigator.clipboard
        .writeText(msg.content)
        .then(() => {
          showToast('已复制');
        })
        .catch(() => {
          showToast('复制失败');
        });
      closeMenu();
    },
    [messages, closeMenu]
  );

  // 引用消息
  const handleQuote = useCallback(
    (msgId: number) => {
      const msg = messages.find((m) => m.id === msgId);
      if (!msg) return;
      setQuoteMsg(msg);
      closeMenu();
      chatInputRef.current?.focus();
    },
    [messages, closeMenu, chatInputRef]
  );

  // 跳转到原消息
  const scrollToMessage = useCallback(
    (msgId: number) => {
      const el = chatMessagesRef.current?.querySelector(`[data-msg-id="${msgId}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add(bubbleStyles.highlight!);
        setTimeout(() => el.classList.remove(bubbleStyles.highlight!), 1500);
      }
    },
    [chatMessagesRef]
  );

  // 撤回消息
  const handleRecall = useCallback(
    async (msgId: number) => {
      closeMenu();
      try {
        await api.delete(`/messages/single/${msgId}`);
        onRemove(msgId);
        showToast('消息已撤回');
      } catch {
        showToast('撤回失败');
      }
    },
    [closeMenu, onRemove]
  );

  return {
    sending,
    quoteMsg,
    setQuoteMsg,
    showClearConfirm,
    setShowClearConfirm,
    handleSend,
    handleSendImage,
    handleClearMessages,
    confirmClearMessages,
    handleCopy,
    handleQuote,
    handleRecall,
    scrollToMessage,
  };
}
