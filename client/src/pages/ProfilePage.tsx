/**
 * ============================================================
 * 个人主页 (ProfilePage)
 * ============================================================
 * 直接渲染 Profile 组件
 * 路由: /profile（自己的主页）和 /profile/:id（他人主页）
 * ============================================================
 */

import Profile from '../components/profile/Profile';

export default function ProfilePage() {
  return <Profile />;
}
