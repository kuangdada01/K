/**
 * ============================================================
 * 用户搜索 Hook（features/messages/hooks）
 * ============================================================
 * 自 Messages.tsx 拆出：新会话的用户搜索（300ms 防抖）。
 * 搜索词清空时的复位逻辑仍留在调用组件（渲染期调整模式）。
 */

import { useEffect, useState } from 'react';
import api from '../../../api/http';

/** 搜索结果行（与 Messages.tsx 原内联类型一致） */
export interface UserSearchResult {
  id: number;
  username: string;
  avatar: string | null;
}

export function useUserSearch() {
  const [followSearch, setFollowSearch] = useState('');
  const [searchResults, setSearchResults] = useState<UserSearchResult[]>([]);
  const [showFollowResults, setShowFollowResults] = useState(false);

  // 搜索用户（所有用户，300ms 防抖；失败静默）
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

  return {
    followSearch,
    setFollowSearch,
    searchResults,
    setSearchResults,
    showFollowResults,
    setShowFollowResults,
  };
}
