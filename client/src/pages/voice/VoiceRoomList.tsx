/**
 * ============================================================
 * 语音房间列表（pages/voice/VoiceRoomList）
 * ============================================================
 * 自 VoicePage.tsx 拆出（§3.2，行为不变）：房间列表（在线人数徽标、
 * 活跃房间排前）+ 创建/删除房间 + 进房。
 * - 未登录用户也可以创建/进入（访客身份，服务端分配负数 id）
 * - 删除权限：创建者（含访客创建者，isCreator 按访问者计算）或管理员
 *
 * 房间列表数据（rooms/loading）与轮询由 VoicePage 编排层持有——
 * 进房期间仍要按 10s 轮询保持人数徽标/创建者身份实时（VoiceRoomView
 * 的"清空聊天"权限依赖当前房间的 isCreator），与拆分前同一数据源。
 * 本组件为展示 + 创建/删除交互层，成功后回调 onRefresh 刷新列表。
 * ============================================================
 */

import { useRef, useState } from 'react';
import { AudioLines, Headphones, Plus, Radio, Trash2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { createVoiceRoom, deleteVoiceRoom } from '../../api/voice';
import { showToast } from '../../components/ui/Toast';
import { getApiErrorMessage } from '../../api/http';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import type { VoiceRoom } from '../../types';
import { VOICE_MAX_ROOM_SIZE } from '@k/shared';
import styles from '../VoicePage.module.css';

export default function VoiceRoomList({
  rooms,
  loading,
  onJoin,
  onRefresh,
}: {
  rooms: VoiceRoom[];
  loading: boolean;
  onJoin: (room: VoiceRoom) => void;
  onRefresh: () => void;
}) {
  const { user } = useAuth();

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [deletingRoom, setDeletingRoom] = useState<VoiceRoom | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) {
      showToast('请输入房间名');
      return;
    }
    try {
      // 未登录用户也可以创建房间（服务端以访客身份分配创建者归属）
      const res = await createVoiceRoom(name, newDesc.trim() || undefined);
      setCreating(false);
      setNewName('');
      setNewDesc('');
      onRefresh();
      showToast(`房间「${res.room.name}」已创建`);
    } catch (e) {
      showToast(getApiErrorMessage(e, '创建失败'));
    }
  };

  const handleDelete = async () => {
    if (!deletingRoom) return;
    try {
      await deleteVoiceRoom(deletingRoom.id);
      showToast('房间已删除');
    } catch (e) {
      showToast(getApiErrorMessage(e, '删除失败'));
    }
    setDeletingRoom(null);
    onRefresh();
  };

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1>语音</h1>
        <button
          className={styles.createBtn}
          onClick={() => {
            // 未登录用户也可以创建房间（以访客身份）
            setCreating(true);
            setTimeout(() => nameInputRef.current?.focus(), 50);
          }}
        >
          <Plus size={16} />
          <span>创建房间</span>
        </button>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-secondary)' }}>加载中...</div>
      ) : rooms.length === 0 ? (
        <div className={styles.empty}>
          <Radio size={48} />
          <p>还没有语音房间，创建一个吧</p>
        </div>
      ) : (
        <div className={styles.roomList}>
          {rooms.map((room) => {
            const count = room.participantCount ?? 0;
            const active = count > 0;
            // 删除权限：房间创建者（含访客创建者，isCreator 由服务端按访问者计算）或管理员
            const canDelete = room.isCreator === true || user?.role === 'admin';
            return (
              <div key={room.id} className={`${styles.roomCard} ${active ? styles.roomActive : ''}`}>
                <div className={styles.roomIcon}>
                  {active ? <AudioLines size={22} /> : <Headphones size={22} />}
                </div>
                <button className={styles.roomBody} onClick={() => onJoin(room)}>
                  <div className={styles.roomName}>{room.name}</div>
                  <div className={styles.roomMeta}>
                    {room.description ? <span className={styles.roomDesc}>{room.description}</span> : null}
                    <span>by {room.creator_username}</span>
                  </div>
                </button>
                <span className={`${styles.countBadge} ${active ? styles.countLive : ''}`}>
                  {count}/{VOICE_MAX_ROOM_SIZE}
                </span>
                {canDelete && (
                  <button className={styles.deleteBtn} title="删除房间" onClick={() => setDeletingRoom(room)}>
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 创建房间弹层 */}
      {creating && (
        <div className={styles.modalMask} onClick={() => setCreating(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h2>创建语音房间</h2>
            <input
              ref={nameInputRef}
              className={styles.input}
              name="room-name"
              placeholder="房间名（1-30字）"
              value={newName}
              maxLength={30}
              onChange={(e) => setNewName(e.target.value)}
            />
            <input
              className={styles.input}
              name="room-desc"
              placeholder="简介（可选，100字以内）"
              value={newDesc}
              maxLength={100}
              onChange={(e) => setNewDesc(e.target.value)}
            />
            <div className={styles.modalActions}>
              <button className={styles.cancelBtn} onClick={() => setCreating(false)}>
                取消
              </button>
              <button className={styles.confirmBtn} onClick={handleCreate}>
                创建
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除房间确认 */}
      {deletingRoom && (
        <ConfirmDialog
          message={`确定删除房间「${deletingRoom.name}」吗？房内成员会被请出。`}
          onConfirm={handleDelete}
          onCancel={() => setDeletingRoom(null)}
        />
      )}
    </div>
  );
}
