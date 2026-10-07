/**
 * ============================================================
 * 私信页面 (MessagesPage)
 * ============================================================
 * 直接渲染 Messages 组件
 * 路由: /messages 和 /messages/:userId
 * ============================================================
 */

import Messages from '../components/chat/Messages';

export default function MessagesPage() {
  return <Messages />;
}
