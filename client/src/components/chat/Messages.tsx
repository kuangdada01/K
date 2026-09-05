/**
 * ============================================================
 * 私信+通知组件 (Messages)
 * ============================================================
 * 集成私信和通知功能的综合组件（状态编排层）
 *
 * 功能:
 * - 会话列表（按最后消息时间排序，显示未读数）
 * - 聊天窗口（文字/图片消息、发送图片）
 * - 通知列表（评论/回复通知，点击跳转帖子详情）
 * - 清除消息确认
 * - 标记通知已读
 *
 * 结构: 数据/行为逻辑保留在本组件，
 * 视图拆分到 components/chat/（ConversationSidebar/ChatWindow/ChatContextMenu/ChatZoomOverlay）。
 * ============================================================
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import api from '../../api/http';
import { Conversation, Message, Notification } from '../../types';
import { useAuth } from '../../context/AuthContext';
import { events } from '../../state/events';
import { useSse } from '../../hooks/useSse';
import { showToast } from '../ui/Toast';
import ConfirmDialog from '../ui/ConfirmDialog';
import PostDetail from '../post/PostDetail';
import ConversationSidebar from './ConversationSidebar';
import ChatWindow, { ChatEmpty } from './ChatWindow';
import ChatContextMenu, { ChatContextMenuData } from './ChatContextMenu';
import ChatZoomOverlay from './ChatZoomOverlay';
import styles from './Messages.module.css';
import bubbleStyles from './MessageBubble.module.css';

/** 合并消息页：按 id 去重后按 id 升序（loadMessages 与 effect 内轮询共用） */
function mergeMessagePages(prev: Message[], newMsgs: Message[]): Message[] {
  const lastPrev = prev[prev.length - 1];
  const lastNew = newMsgs[newMsgs.length - 1];
  // 无新消息：最后一条 ID 相同且已加载数量 ≥ 最新页 → 跳过重渲染（防止滚动位置重置）
  if (lastPrev && lastNew && lastPrev.id === lastNew.id && prev.length >= newMsgs.length) return prev;
  if (prev.length === 0 && newMsgs.length === 0) return prev;
  // 合并：保留已加载的更早消息，用最新页补齐/更新
  const byId = new Map(prev.map((m) => [m.id, m]));
  for (const m of newMsgs) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

export default function Messages() {
  const { userId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [selectedPartner, setSelectedPartner] = useState<Conversation | null>(null);
  // P9 修复：输入文字 state 已下沉到 ChatComposer，此处不再持有 newMessage
  // 本地已清除未读的会话集合: partner_id → 清除时的 unread_count
  const clearedUnreadRef = useRef<Map<number, number>>(new Map());
  const [activeTab, setActiveTab] = useState<'messages' | 'notifications'>('messages');
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadNotifs, setUnreadNotifs] = useState(0);
  const [sending, setSending] = useState(false);
  const [zoomImage, setZoomImage] = useState<string | null>(null);
  const [zoomClosing, setZoomClosing] = useState(false);
  const [contextMenu, setContextMenu] = useState<ChatContextMenuData | null>(null);
  const [quoteMsg, setQuoteMsg] = useState<Message | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [selectedPostId, setSelectedPostId] = useState<number | null>(null);
  const [highlightCommentId, setHighlightCommentId] = useState<number | null>(null);
  const [followSearch, setFollowSearch] = useState('');
  const [searchResults, setSearchResults] = useState<
    { id: number; username: string; avatar: string | null }[]
  >([]);
  const [showFollowResults, setShowFollowResults] = useState(false);
  const chatMessagesRef = useRef<HTMLDivElement>(null);
  const scrollSentinelRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const chatInputRef = useRef<HTMLInputElement>(null);
  const postDetailHandledBack = useRef(false);
  const initialScrollRef = useRef(true);
  // 分页相关
  const messagesRef = useRef<Message[]>([]);
  const hasMoreRef = useRef(false);
  const loadingOlderRef = useRef(false);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // 返回键：处理对话和标签页的返回逻辑
  // 安卓端主 Tab 退出由 App.tsx 统一处理，此处仅处理对话关闭
  useEffect(() => {
    const handlePopState = () => {
      if (postDetailHandledBack.current) {
        postDetailHandledBack.current = false;
        return;
      }
      if (selectedPostId) return; // PostDetail 会自己处理
      if (selectedPartner) {
        setSelectedPartner(null);
      } else if (!Capacitor.isNativePlatform() && activeTab === 'notifications') {
        // 仅 web 端：通知标签页返回到消息标签页
        setActiveTab('messages');
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [selectedPartner, activeTab, selectedPostId]);

  // Load conversations and notifications (合并轮询减少请求)
  const refreshConversations = useCallback(async () => {
    try {
      const [convRes, notifRes] = await Promise.all([
        api.get('/messages/conversations'),
        api.get('/notifications'),
      ]);
      // 合并本地已清除的未读状态，防止服务器未及时更新导致角标回弹
      const merged = (convRes.data.conversations as Conversation[]).map((conv) => {
        const clearedAt = clearedUnreadRef.current.get(conv.partner_id);
        if (clearedAt !== undefined) {
          if (conv.unread_count === 0) {
            clearedUnreadRef.current.delete(conv.partner_id);
          } else if (conv.unread_count <= clearedAt) {
            return { ...conv, unread_count: 0 };
          } else {
            // 有新消息到达（count > 清除时），显示新角标
            clearedUnreadRef.current.delete(conv.partner_id);
          }
        }
        return conv;
      });
      setConversations(merged);
      setNotifications(notifRes.data.notifications);
      setUnreadNotifs(notifRes.data.unread_count);
    } catch {}
  }, []);

  useEffect(() => {
    refreshConversations();
    const interval = setInterval(refreshConversations, 10000);
    return () => clearInterval(interval);
  }, [refreshConversations]);

  // 拉取最新消息页并合并（保留已加载的更早历史）
  const loadMessages = useCallback(async () => {
    if (!userId) return;
    const partnerId = parseInt(userId);
    try {
      const res = await api.get(`/messages/${partnerId}`, { params: { limit: 50 } });
      const newMsgs = res.data.messages as Message[];
      hasMoreRef.current = !!res.data.has_more;
      setMessages((prev) => mergeMessagePages(prev, newMsgs));
    } catch {}
  }, [userId]);

  // 渲染期同步 selectedPartner（prev 值模式）：仅当 partner 变化时调整，
  // 替代 effect 内同步 setState（react-hooks/set-state-in-effect）
  const activePartnerId = userId ? parseInt(userId) : null;
  const activeConv =
    activePartnerId !== null ? conversations.find((c) => c.partner_id === activePartnerId) : undefined;
  if (activePartnerId !== null && selectedPartner?.partner_id !== activePartnerId) {
    setSelectedPartner(
      activeConv ?? {
        partner_id: activePartnerId,
        username: '',
        avatar: null,
        last_message: '',
        last_message_at: '',
        unread_count: 0,
      }
    );
  }

  // Load messages when partner selected + poll for new messages
  useEffect(() => {
    if (!userId) return;
    const partnerId = parseInt(userId);
    initialScrollRef.current = true;

    // 骨架 partner（本体已在渲染期同步）：用户名/头像异步填充
    const conv = conversations.find((c) => c.partner_id === partnerId);
    if (!conv) {
      api.get(`/users/${partnerId}`).then((res) => {
        setSelectedPartner((prev) =>
          prev?.partner_id === partnerId
            ? {
                ...prev,
                username: res.data.username,
                avatar: res.data.avatar,
              }
            : prev
        );
      });
    }

    // 拉取 + 轮询：async 函数定义在 effect 内，await 边界可被规则正确识别
    const pollMessages = async () => {
      if (!userId) return;
      const pid = parseInt(userId);
      try {
        const res = await api.get(`/messages/${pid}`, { params: { limit: 50 } });
        const newMsgs = res.data.messages as Message[];
        hasMoreRef.current = !!res.data.has_more;
        setMessages((prev) => mergeMessagePages(prev, newMsgs));
      } catch {}
    };
    pollMessages();
    const interval = setInterval(pollMessages, 5000);

    return () => clearInterval(interval);
    // 历史实现仅在 userId 变化时重建（conversations 通过闭包读取当时的快照）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  // 首次加载标记：column-reverse 天然从底部开始，无需 JS 滚动
  useEffect(() => {
    if (messages.length === 0) return;
    if (initialScrollRef.current) {
      initialScrollRef.current = false;
    }
  }, [messages.length, userId]);

  // 向上翻页加载更早消息（保持滚动位置）
  const loadOlder = useCallback(async () => {
    if (!userId || loadingOlderRef.current || !hasMoreRef.current) return;
    const oldest = messagesRef.current[0];
    if (!oldest) return;
    const partnerId = parseInt(userId);
    const el = chatMessagesRef.current;
    const prevScrollTop = el ? el.scrollTop : 0;
    const prevScrollHeight = el ? el.scrollHeight : 0;
    loadingOlderRef.current = true;
    try {
      const res = await api.get(`/messages/${partnerId}`, { params: { limit: 50, before_id: oldest.id } });
      const olderMsgs = res.data.messages as Message[];
      hasMoreRef.current = !!res.data.has_more;
      if (olderMsgs.length > 0) {
        setMessages((prev) => {
          const byId = new Map(prev.map((m) => [m.id, m]));
          for (const m of olderMsgs) byId.set(m.id, m);
          return [...byId.values()].sort((a, b) => a.id - b.id);
        });
        requestAnimationFrame(() => {
          if (el) {
            el.scrollTop = prevScrollTop + (el.scrollHeight - prevScrollHeight);
          }
        });
      }
    } catch {
    } finally {
      loadingOlderRef.current = false;
    }
  }, [userId]);

  // 滚动接近历史顶部时加载更早消息
  useEffect(() => {
    const el = chatMessagesRef.current;
    if (!el) return;
    const handleChatScroll = () => {
      if (el.scrollTop > el.scrollHeight - el.clientHeight - 300) {
        loadOlder();
      }
    };
    el.addEventListener('scroll', handleChatScroll);
    return () => el.removeEventListener('scroll', handleChatScroll);
  }, [loadOlder]);

  // SSE 实时推送：新消息/通知到达时立即刷新
  useSse(user?.id, (type, data) => {
    if (type === 'message') {
      const currentPartnerId = userId ? parseInt(userId) : null;
      const { from, to } = data;
      // 仅当事件涉及当前对话或自身时刷新
      if (currentPartnerId && (Number(from) === currentPartnerId || Number(to) === currentPartnerId)) {
        loadMessages();
      }
      refreshConversations();
    } else if (type === 'notification') {
      refreshConversations();
    }
  });

  // 新消息到达：column-reverse 下 scrollTop=0 即底部，仅在用户未上滑时保持底部
  useEffect(() => {
    if (messages.length === 0) return;
    const el = chatMessagesRef.current;
    if (!el || initialScrollRef.current) return;
    // scrollTop 接近 0 → 用户在底部，保持底部
    if (el.scrollTop < 100) {
      el.scrollTop = 0;
    }
  }, [messages.length]);

  // 搜索词清空时立即复位结果（渲染期调整，替代 effect 内同步 setState）
  if (!followSearch.trim()) {
    if (searchResults.length > 0) setSearchResults([]);
    if (showFollowResults) setShowFollowResults(false);
  }

  // 搜索用户（所有用户）
  useEffect(() => {
    if (!followSearch.trim()) return;
    const timer = setTimeout(async () => {
      try {
        const res = await api.get('/friends/search', { params: { q: followSearch.trim() } });
        setSearchResults(res.data.users || []);
        setShowFollowResults(true);
      } catch {}
    }, 300);
    return () => clearTimeout(timer);
  }, [followSearch]);

  const handleClearMessages = () => {
    if (!selectedPartner) return;
    setShowClearConfirm(true);
  };

  const confirmClearMessages = async () => {
    if (!selectedPartner) return;
    try {
      await api.delete(`/messages/${selectedPartner.partner_id}`);
      setMessages([]);
      const res = await api.get('/messages/conversations');
      setConversations(res.data.conversations);
    } catch {
      showToast('清除失败');
    }
    setShowClearConfirm(false);
  };

  const handleSend = async (text: string) => {
    const content = text.trim();
    if (!content || !selectedPartner || sending) return;
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
      setMessages((prev) => [...prev, res.data]);
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

    // 检查图片大小 (10MB)
    const maxSize = 10 * 1024 * 1024;
    if (file.size > maxSize) {
      showToast('图片超过10MB限制');
      if (imageInputRef.current) imageInputRef.current.value = '';
      return;
    }

    setSending(true);
    try {
      const formData = new FormData();
      formData.append('receiverId', String(selectedPartner.partner_id));
      formData.append('image', file);
      const res = await api.post('/messages', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setMessages((prev) => [...prev, res.data]);
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

  const closeZoom = () => {
    setZoomClosing(true);
    setTimeout(() => {
      setZoomImage(null);
      setZoomClosing(false);
    }, 200);
  };

  // 关闭上下文菜单
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [contextMenu]);

  // 长按触发（移动端）
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleTouchStart = useCallback(
    (e: React.TouchEvent, msg: Message) => {
      const target = e.currentTarget;
      longPressTimer.current = setTimeout(() => {
        const isSent = msg.sender_id === user?.id;
        setContextMenu({ msgId: msg.id, isSent, rect: target.getBoundingClientRect() });
      }, 500);
    },
    [user]
  );

  const handleTouchEnd = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const handleTouchMove = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  // 右键触发（Web 端）
  const handleContextMenu = useCallback(
    (e: React.MouseEvent, msg: Message) => {
      e.preventDefault();
      const isSent = msg.sender_id === user?.id;
      setContextMenu({ msgId: msg.id, isSent, rect: e.currentTarget.getBoundingClientRect() });
    },
    [user]
  );

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
      setContextMenu(null);
    },
    [messages]
  );

  // 引用消息
  const handleQuote = useCallback(
    (msgId: number) => {
      const msg = messages.find((m) => m.id === msgId);
      if (!msg) return;
      setQuoteMsg(msg);
      setContextMenu(null);
      chatInputRef.current?.focus();
    },
    [messages]
  );

  // 跳转到原消息
  const scrollToMessage = useCallback((msgId: number) => {
    const el = chatMessagesRef.current?.querySelector(`[data-msg-id="${msgId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add(bubbleStyles.highlight);
      setTimeout(() => el.classList.remove(bubbleStyles.highlight), 1500);
    }
  }, []);

  // 撤回消息
  const handleRecall = useCallback(async (msgId: number) => {
    setContextMenu(null);
    try {
      await api.delete(`/messages/single/${msgId}`);
      setMessages((prev) => prev.filter((m) => m.id !== msgId));
      showToast('消息已撤回');
    } catch {
      showToast('撤回失败');
    }
  }, []);

  const handleSelectConversation = (c: Conversation) => {
    setSelectedPartner(c);
    // 立即清除该会话的本地未读角标，并用 ref 阻止轮询回弹
    if (c.unread_count > 0) {
      clearedUnreadRef.current.set(c.partner_id, c.unread_count);
      setConversations((prev) =>
        prev.map((cc) => (cc.partner_id === c.partner_id ? { ...cc, unread_count: 0 } : cc))
      );
      events.emit('badge:changed', { source: 'msg', count: c.unread_count });
    }
    navigate(`/messages/${c.partner_id}`);
  };

  const handleNotificationClick = (n: Notification) => {
    if (!n.read) {
      api.put(`/notifications/${n.id}/read`).catch(() => {});
      setNotifications((prev) => prev.map((nn) => (nn.id === n.id ? { ...nn, read: 1 } : nn)));
      setUnreadNotifs((prev) => Math.max(0, prev - 1));
      events.emit('badge:changed', { source: 'notif' }); // 通知侧边栏刷新未读数
    }
    if (n.post_id) {
      window.history.pushState(null, '', window.location.href);
      setSelectedPostId(n.post_id);
      setHighlightCommentId(n.comment_id || null);
    }
  };

  return (
    <div className={styles.layout}>
      <ConversationSidebar
        user={user}
        followSearch={followSearch}
        setFollowSearch={setFollowSearch}
        showFollowResults={showFollowResults}
        setShowFollowResults={setShowFollowResults}
        searchResults={searchResults}
        onNavigateProfile={(id) => navigate(`/profile/${id}`)}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        unreadNotifs={unreadNotifs}
        conversations={conversations}
        selectedPartnerId={selectedPartner?.partner_id}
        onSelectConversation={handleSelectConversation}
        notifications={notifications}
        onNotificationClick={handleNotificationClick}
      />

      <div className={`${styles.chatArea}${selectedPartner ? ` ${styles.hasPartner}` : ''}`}>
        {selectedPartner ? (
          <ChatWindow
            user={user}
            selectedPartner={selectedPartner}
            messages={messages}
            chatMessagesRef={chatMessagesRef}
            scrollSentinelRef={scrollSentinelRef}
            sending={sending}
            quoteMsg={quoteMsg}
            setQuoteMsg={setQuoteMsg}
            imageInputRef={imageInputRef}
            chatInputRef={chatInputRef}
            onBack={() => {
              window.history.back();
            }}
            onClear={handleClearMessages}
            onSend={handleSend}
            onSendImage={handleSendImage}
            onContextMenu={handleContextMenu}
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
            onTouchMove={handleTouchMove}
            onZoomImage={(url) => setZoomImage(url)}
            onScrollToMessage={(id) => scrollToMessage(id)}
          />
        ) : (
          <ChatEmpty />
        )}
      </div>

      {zoomImage && <ChatZoomOverlay zoomImage={zoomImage} zoomClosing={zoomClosing} onClose={closeZoom} />}

      {contextMenu && (
        <ChatContextMenu
          contextMenu={contextMenu}
          onCopy={handleCopy}
          onQuote={handleQuote}
          onRecall={handleRecall}
        />
      )}

      {showClearConfirm && (
        <ConfirmDialog
          message="确定要清除与该用户的所有消息吗？"
          onConfirm={confirmClearMessages}
          onCancel={() => setShowClearConfirm(false)}
        />
      )}

      {selectedPostId && (
        <PostDetail
          postId={selectedPostId}
          highlightCommentId={highlightCommentId}
          onClose={() => {
            postDetailHandledBack.current = true;
            setSelectedPostId(null);
            setHighlightCommentId(null);
          }}
        />
      )}
    </div>
  );
}
