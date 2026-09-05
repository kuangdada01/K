/**
 * ============================================================
 * 全局 UI 事件上下文 (EventContext)
 * ============================================================
 * 管理全局模态框状态（创建/编辑帖子）。
 *
 * 注意: 跨组件业务事件（帖子创建、角标变化、关注变化）已迁移到
 * mitt 事件总线（见 state/events.ts），不再用计数器模拟。
 *
 * 使用方式:
 * - 在 App.tsx 中用 <EventProvider> 包裹应用
 * - 在组件中调用 useEvent() 获取状态和方法
 */

import { createContext, useContext, useState, useCallback, ReactNode } from 'react';

/** 编辑帖子时传入的数据结构 */
export interface EditPostData {
  id: number; // 帖子ID
  description: string; // 帖子描述
  images: string[]; // 当前图片列表
  closeComments: boolean; // 是否关闭评论
  pinned: boolean; // 是否置顶
  videoUrl?: string | null; // 视频URL（视频帖子时有值）
  videoCover?: string | null; // 视频封面URL
}

/** 全局事件上下文类型定义 */
interface EventContextType {
  // 帖子相关
  showCreate: boolean; // 是否显示创建帖子模态框
  openCreate: () => void; // 打开创建模态框
  closeCreate: () => void; // 关闭创建模态框
  editPost: EditPostData | null; // 编辑中的帖子数据（null=不在编辑状态）
  openEdit: (post: EditPostData) => void; // 打开编辑模态框
  closeEdit: () => void; // 关闭编辑模态框
  onEditSave?: () => void; // 编辑保存后的回调函数
  setOnEditSave: (callback: () => void) => void; // 注册编辑保存回调
}

const EventContext = createContext<EventContextType | undefined>(undefined);

/**
 * 全局事件上下文提供者组件
 */
export function EventProvider({ children }: { children: ReactNode }) {
  const [showCreate, setShowCreate] = useState(false);
  const [editPost, setEditPost] = useState<EditPostData | null>(null);
  const [onEditSave, setOnEditSave] = useState<(() => void) | undefined>();

  const openCreate = useCallback(() => setShowCreate(true), []);
  const closeCreate = useCallback(() => setShowCreate(false), []);
  const openEdit = useCallback((post: EditPostData) => setEditPost(post), []);
  const closeEdit = useCallback(() => setEditPost(null), []);

  return (
    <EventContext.Provider
      value={{
        showCreate,
        openCreate,
        closeCreate,
        editPost,
        openEdit,
        closeEdit,
        onEditSave,
        setOnEditSave,
      }}
    >
      {children}
    </EventContext.Provider>
  );
}

/**
 * 全局事件上下文 Hook
 *
 * @returns 全局模态框状态和方法
 * @throws 如果在 EventProvider 外使用则抛出错误
 */
export function useEvent() {
  const context = useContext(EventContext);
  if (!context) {
    throw new Error('useEvent must be used within an EventProvider');
  }
  return context;
}
