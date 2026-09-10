/**
 * ============================================================
 * 私信+通知组件 (Messages) —— 状态编排层
 * ============================================================
 * 集成私信和通知功能的综合组件。数据/行为已按功能域拆到
 * features/messages/hooks（会话/通知、消息数据、聊天操作、
 * 用户搜索、上下文菜单），视图在 components/chat/。
 *
 * 本组件仅保留：路由参数解析、selectedPartner 渲染期同步、
 * 返回键 popstate、通知点击（PostDetail 嵌入）、SSE 事件分发
 * 与 JSX 编排。
 * ============================================================
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import api from '../../api/http';
import { Conversation, Notification } from '../../types';
import { useAuth } from '../../context/AuthContext';
import { events } from '../../state/events';
import { useSse } from '../../hooks/useSse';
import ConfirmDialog from '../ui/ConfirmDialog';
import PostDetail from '../post/PostDetail';
import ConversationSidebar from './ConversationSidebar';
import ChatWindow, { ChatEmpty } from './ChatWindow';
import ChatContextMenu from './ChatContextMenu';
import ChatZoomOverlay from './ChatZoomOverlay';
import { useConversations } from '../../features/messages/hooks/useConversations';
import { useMessages } from '../../features/messages/hooks/useMessages';
import { useChatActions } from '../../features/messages/hooks/useChatActions';
import { useUserSearch } from '../../features/messages/hooks/useUserSearch';
import { useContextMenu } from '../../features/messages/hooks/useContextMenu';
import styles from './Messages.module.css';

export default function Messages() {
  const { userId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  const {
    conversations,
    setConversations,
    conversationsRef,
    notifications,
    setNotifications,
    unreadNotifs,
    setUnreadNotifs,
    refreshConversations,
    clearLocalUnread,
  } = useConversations();

  const {
    followSearch,
    setFollowSearch,
    searchResults,
    setSearchResults,
    showFollowResults,
    setShowFollowResults,
  } = useUserSearch();

  const [selectedPartner, setSelectedPartner] = useState<Conversation | null>(null);
  const [activeTab, setActiveTab] = useState<'messages' | 'notifications'>('messages');
  const [selectedPostId, setSelectedPostId] = useState<number | null>(null);
  const [highlightCommentId, setHighlightCommentId] = useState<number | null>(null);
  const chatMessagesRef = useRef<HTMLDivElement>(null);
  const scrollSentinelRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const chatInputRef = useRef<HTMLInputElement>(null);
  const postDetailHandledBack = useRef(false);

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

  // 骨架用户信息回填（会话列表里没有该用户时，由消息数据层拉取后回调）
  const handlePartnerInfo = useCallback((partnerId: number, username: string, avatar: string | null) => {
    setSelectedPartner((prev) => (prev?.partner_id === partnerId ? { ...prev, username, avatar } : prev));
  }, []);

  const {
    messages,
    sessionEpochRef,
    initialScrollRef,
    loadOlder,
    handleSseMessage,
    appendMessage,
    removeMessageById,
    clearMessagesLocal,
  } = useMessages({
    partnerId: activePartnerId,
    conversationsRef,
    onPartnerInfo: handlePartnerInfo,
    refreshConversations,
    chatMessagesRef,
  });

  const menu = useContextMenu(user?.id);

  const {
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
  } = useChatActions({
    selectedPartner,
    messages,
    sessionEpochRef,
    chatMessagesRef,
    chatInputRef,
    imageInputRef,
    setConversations,
    onAppend: appendMessage,
    onRemove: removeMessageById,
    onClearLocal: clearMessagesLocal,
    closeMenu: menu.closeMenu,
  });

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

  // 首次加载标记：column-reverse 天然从底部开始，无需 JS 滚动
  useEffect(() => {
    if (messages.length === 0) return;
    if (initialScrollRef.current) {
      initialScrollRef.current = false;
    }
  }, [messages.length, userId, initialScrollRef]);

  // 新消息到达：column-reverse 下 scrollTop=0 即底部，仅在用户未上滑时保持底部
  useEffect(() => {
    if (messages.length === 0) return;
    const el = chatMessagesRef.current;
    if (!el || initialScrollRef.current) return;
    // scrollTop 接近 0 → 用户在底部，保持底部
    if (el.scrollTop < 100) {
      el.scrollTop = 0;
    }
  }, [messages.length, initialScrollRef]);

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

  // 搜索词清空时立即复位结果（渲染期调整，替代 effect 内同步 setState）
  if (!followSearch.trim()) {
    if (searchResults.length > 0) setSearchResults([]);
    if (showFollowResults) setShowFollowResults(false);
  }

  // SSE 实时推送：message → 消息数据层对账；notification → 刷新会话/通知
  useSse(user?.id, (type, data) => {
    if (type === 'message') {
      handleSseMessage(data);
    } else if (type === 'notification') {
      refreshConversations();
    }
  });

  const handleSelectConversation = (c: Conversation) => {
    setSelectedPartner(c);
    clearLocalUnread(c);
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
            onContextMenu={menu.handleContextMenu}
            onTouchStart={menu.handleTouchStart}
            onTouchEnd={menu.handleTouchEnd}
            onTouchMove={menu.handleTouchMove}
            onZoomImage={menu.setZoomImage}
            onScrollToMessage={(id) => scrollToMessage(id)}
          />
        ) : (
          <ChatEmpty />
        )}
      </div>

      {menu.zoomImage && <ChatZoomOverlay zoomImage={menu.zoomImage} onClose={menu.closeZoom} />}

      {menu.contextMenu && (
        <ChatContextMenu
          contextMenu={menu.contextMenu}
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
