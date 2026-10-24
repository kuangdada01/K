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

import { useState, useEffect, useRef, useCallback, Suspense, lazy } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { isNative } from '../../lib/native';
import api, { getApiErrorMessage } from '../../api/http';
import { isExecutableFile } from '@k/shared';
import { Conversation, Message, Notification } from '../../types';
import { useAuth } from '../../context/AuthContext';
import { events } from '../../state/events';
import { markNotificationReadLocal } from '../../state/inboxStore';
import { useSse } from '../../hooks/useSse';
import ConfirmDialog from '../ui/ConfirmDialog';
import { showToast } from '../ui/Toast';
import ReportDialog from './ReportDialog';
// PostDetail 懒加载：浮层只在点开帖子时用到，静态 import 会把它连着
// PostMedia/手势 hook 的子树打进私信页 chunk（与 HomePage 同一处理）
import { loadPostDetail } from '../../router/composerChunks';
const LazyPostDetail = lazy(loadPostDetail);
import ConversationSidebar from './ConversationSidebar';
import ChatWindow, { ChatEmpty } from './ChatWindow';
import ChatContextMenu from './ChatContextMenu';
import ChatZoomOverlay from './ChatZoomOverlay';
import FilePreviewOverlay from './FilePreviewOverlay';
import { useConversations } from '../../features/messages/hooks/useConversations';
import { useMessages } from '../../features/messages/hooks/useMessages';
import { useChatActions } from '../../features/messages/hooks/useChatActions';
import { useFileUpload } from '../../features/messages/hooks/useFileUpload';
import { useUserSearch } from '../../features/messages/hooks/useUserSearch';
import { useContextMenu } from '../../features/messages/hooks/useContextMenu';
import { downloadMessageFile } from '../../features/messages/utils/fileMessage';
import styles from './Messages.module.css';

export default function Messages() {
  const { userId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  const {
    conversations,
    conversationsRef,
    notifications,
    unreadNotifs,
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatInputRef = useRef<HTMLInputElement>(null);
  const postDetailHandledBack = useRef(false);
  /** 站内文件预览（图片/音视频/PDF/文本）；null = 不显示浮层 */
  const [previewFile, setPreviewFile] = useState<Message | null>(null);

  // ---- 举报 / 拉黑 / 可执行文件警示（2026-10-24）----
  /** 正在选理由的举报对象；null = 不显示对话框 */
  const [reportMsg, setReportMsg] = useState<Message | null>(null);
  /** 等待「确定下载」确认的安装包/可执行文件 */
  const [execFileConfirm, setExecFileConfirm] = useState<Message | null>(null);
  /** 拉黑确认：null 不显示；'block' / 'unblock' 决定文案与动作 */
  const [blockConfirm, setBlockConfirm] = useState<'block' | 'unblock' | null>(null);
  /** 我拉黑的用户 id 列表（会话页横幅/按钮状态） */
  const [blockedIds, setBlockedIds] = useState<number[]>([]);

  // 拉黑列表只在整个私信页挂载时取一次（拉黑/解除时本地同步增删）
  useEffect(() => {
    api
      .get<{ blocked_ids: number[] }>('/messages/blocks')
      .then((res) => setBlockedIds(res.data.blocked_ids ?? []))
      .catch(() => {});
  }, []);

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

  const partnerBlocked = activePartnerId !== null && blockedIds.includes(activePartnerId);

  /** 头部禁止图标：先弹确认再调接口（拉黑/解除都不可随手点） */
  const handleToggleBlockClick = useCallback(() => {
    setBlockConfirm(partnerBlocked ? 'unblock' : 'block');
  }, [partnerBlocked]);

  const confirmToggleBlock = useCallback(async () => {
    if (activePartnerId === null) return;
    const wasBlocked = blockedIds.includes(activePartnerId);
    try {
      if (wasBlocked) {
        await api.delete(`/messages/${activePartnerId}/block`);
        setBlockedIds((prev) => prev.filter((id) => id !== activePartnerId));
        showToast('已解除拉黑');
      } else {
        await api.post(`/messages/${activePartnerId}/block`);
        setBlockedIds((prev) => [...prev, activePartnerId]);
        showToast('已拉黑，对方无法再给你发消息');
      }
    } catch (err) {
      showToast(getApiErrorMessage(err, '操作失败，请稍后重试'));
    }
  }, [activePartnerId, blockedIds]);

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
    markRecalled,
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
    refreshConversations,
    onAppend: appendMessage,
    onRecalled: markRecalled,
    onClearLocal: clearMessagesLocal,
    closeMenu: menu.closeMenu,
  });

  // 文件上传队列：选完就传，进度/失败重试在输入栏上方的托盘里
  const { uploads, enqueueFiles, retryUpload, dismissUpload } = useFileUpload({
    partnerId: activePartnerId,
    onSent: (m) => {
      appendMessage(m);
      // column-reverse：scrollTop = 0 即底部（与文字发送一致）
      requestAnimationFrame(() => {
        const el = chatMessagesRef.current;
        if (el) el.scrollTop = 0;
      });
    },
    refreshConversations,
  });

  /** 选文件后立刻入队；清空 value 让「同一个文件再发一次」也能触发 change */
  const handlePickFiles = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) enqueueFiles(e.target.files);
      e.target.value = '';
    },
    [enqueueFiles]
  );

  /**
   * 下载文件消息：附件要带鉴权，失败给明确 toast（不是静默）。
   * 安装包/可执行文件（apk/exe…）先过一道警示确认 —— 聊天传安装包是
   * 安卓木马最典型的投递方式，多这一次点击能挡掉绝大多数顺手点开。
   */
  const handleDownloadFile = useCallback(async (msg: Message) => {
    if (isExecutableFile(msg.file_name ?? '')) {
      setExecFileConfirm(msg);
      return;
    }
    try {
      await downloadMessageFile(msg);
    } catch (err) {
      showToast(getApiErrorMessage(err, '下载失败，请稍后重试'));
    }
  }, []);

  /** 确认下载安装包/可执行文件（警示对话框的确认分支） */
  const confirmDownloadExecFile = useCallback(async () => {
    const msg = execFileConfirm;
    setExecFileConfirm(null);
    if (!msg) return;
    try {
      await downloadMessageFile(msg);
    } catch (err) {
      showToast(getApiErrorMessage(err, '下载失败，请稍后重试'));
    }
  }, [execFileConfirm]);

  /** 长按菜单「举报」：找到那条消息，弹理由选择 */
  const handleReport = useCallback(
    (msgId: number) => {
      const msg = messages.find((m) => m.id === msgId);
      if (msg) setReportMsg(msg);
    },
    [messages]
  );

  /** 提交举报（服务端算文件哈希、限频；重复举报幂等） */
  const submitReport = useCallback(
    async (reason: string) => {
      const msg = reportMsg;
      setReportMsg(null);
      if (!msg) return;
      try {
        await api.post(`/messages/${msg.id}/report`, { reason });
        showToast('已举报，管理员会尽快处理');
      } catch (err) {
        showToast(getApiErrorMessage(err, '举报失败，请稍后重试'));
      }
    },
    [reportMsg]
  );

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
      } else if (!isNative() && activeTab === 'notifications') {
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
      // 乐观已读在共享 store 里完成（与侧边栏角标同源），事件只触发服务器对账
      markNotificationReadLocal(n.id);
      events.emit('badge:changed', { source: 'notif' });
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
            fileInputRef={fileInputRef}
            chatInputRef={chatInputRef}
            uploadItems={uploads}
            onBack={() => {
              window.history.back();
            }}
            onClear={handleClearMessages}
            onSend={handleSend}
            onSendImage={handleSendImage}
            onPickFiles={handlePickFiles}
            onRetryUpload={retryUpload}
            onDismissUpload={dismissUpload}
            onContextMenu={menu.handleContextMenu}
            onTouchStart={menu.handleTouchStart}
            onTouchEnd={menu.handleTouchEnd}
            onTouchMove={menu.handleTouchMove}
            onZoomImage={menu.setZoomImage}
            onScrollToMessage={(id) => scrollToMessage(id)}
            onPreviewFile={setPreviewFile}
            onDownloadFile={handleDownloadFile}
            partnerBlocked={partnerBlocked}
            onToggleBlock={handleToggleBlockClick}
          />
        ) : (
          <ChatEmpty />
        )}
      </div>

      {menu.zoomImage && <ChatZoomOverlay zoomImage={menu.zoomImage} onClose={menu.closeZoom} />}

      {previewFile && <FilePreviewOverlay msg={previewFile} onClose={() => setPreviewFile(null)} />}

      {menu.contextMenu && (
        <ChatContextMenu
          contextMenu={menu.contextMenu}
          onCopy={handleCopy}
          onQuote={handleQuote}
          onReport={handleReport}
          onRecall={handleRecall}
        />
      )}

      {/* 举报：选理由 → 提交（摘要取文件名或正文，让用户确认举报的就是这条） */}
      {reportMsg && (
        <ReportDialog
          summary={
            reportMsg.file_name ||
            reportMsg.content.slice(0, 60) ||
            (reportMsg.image_url ? '[图片]' : '[语音]')
          }
          onCancel={() => setReportMsg(null)}
          onSubmit={submitReport}
        />
      )}

      {/* 安装包/可执行文件下载警示 */}
      {execFileConfirm && (
        <ConfirmDialog
          message={`「${execFileConfirm.file_name || '该文件'}」是安装包/可执行文件，可能危害设备。确定要下载吗？`}
          onConfirm={confirmDownloadExecFile}
          onCancel={() => setExecFileConfirm(null)}
        />
      )}

      {/* 拉黑/解除拉黑确认 */}
      {blockConfirm && (
        <ConfirmDialog
          message={
            blockConfirm === 'block'
              ? `拉黑后双方都无法发送私信（已有消息保留）。确定拉黑「${selectedPartner?.username || '该用户'}」吗？`
              : '确定解除拉黑吗？解除后双方可以继续互发私信。'
          }
          onConfirm={() => {
            setBlockConfirm(null);
            void confirmToggleBlock();
          }}
          onCancel={() => setBlockConfirm(null)}
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
        <Suspense fallback={null}>
          <LazyPostDetail
            postId={selectedPostId}
            highlightCommentId={highlightCommentId}
            onClose={() => {
              postDetailHandledBack.current = true;
              setSelectedPostId(null);
              setHighlightCommentId(null);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
