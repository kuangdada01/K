/**
 * 个人主页覆盖层 — 复用完整 Profile 组件
 * 全屏覆盖在帖子详情页上，无底部导航栏
 */

import { useState, useCallback } from 'react';
import Profile from './Profile';
import '../../styles/profile_overlay.css';

interface ProfileOverlayProps {
  userId: number;
  onClose: () => void;
}

export default function ProfileOverlay({ userId, onClose }: ProfileOverlayProps) {
  const [closing, setClosing] = useState(false);

  const handleClose = useCallback(() => {
    setClosing(true);
    setTimeout(() => onClose(), 250);
  }, [onClose]);

  return (
    <div className={`profile-overlay${closing ? ' closing' : ''}`} data-back onClick={e => e.stopPropagation()}>
      <Profile embeddedUserId={userId} onBack={handleClose} />
    </div>
  );
}