/**
 * ============================================================
 * 语音房间页面 (VoicePage) —— 编排层
 * ============================================================
 * Kook 式语音频道（§3.2 拆分后）：
 * - 未进房: VoiceRoomList（房间列表/创建/删除）
 * - 进房后: VoiceRoomView（成员网格/聊天面板/控制栏/录制）
 * 实时逻辑全部在 VoiceContext（WS 信令 + WebRTC Mesh，应用级、切页不断开）。
 *
 * 本层保留房间列表数据与轮询（进房期间仍 10s 刷新：人数徽标与
 * VoiceRoomView 的"清空聊天"权限依赖当前房间 isCreator，与拆分前
 * 同一数据源同一时刻）；TTS/聊天/控制栏等已拆入子组件与 useChatTTS。
 * ============================================================
 */

import { useCallback, useEffect, useState } from 'react';
import { useVoice } from '../context/VoiceContext';
import { listVoiceRooms } from '../api/voice';
import { showToast } from '../components/ui/Toast';
import VoiceRoomList from './voice/VoiceRoomList';
import VoiceRoomView from './voice/VoiceRoomView';
import type { VoiceRoom } from '../types';
import { VOICE_MAX_ROOM_SIZE } from '@k/shared';

export default function VoicePage() {
  const voice = useVoice();

  const [rooms, setRooms] = useState<VoiceRoom[]>([]);
  const [loading, setLoading] = useState(true);

  const refreshRooms = useCallback(() => {
    listVoiceRooms()
      .then((res) => setRooms(res.rooms || []))
      .catch(() => {
        /* 静默失败，保留下次刷新 */
      });
  }, []);

  useEffect(() => {
    listVoiceRooms()
      .then((res) => setRooms(res.rooms || []))
      .catch(() => setRooms([]))
      .finally(() => setLoading(false));
  }, []);

  // 进房期间轮询房间列表（人数徽标实时化）；会话结束后刷新一次
  useEffect(() => {
    if (!voice.inRoom) return;
    const timer = window.setInterval(refreshRooms, 10_000);
    return () => clearInterval(timer);
  }, [voice.inRoom, refreshRooms]);

  useEffect(() => {
    if (voice.status === 'ended') refreshRooms();
  }, [voice.status, refreshRooms]);

  const handleJoin = (room: VoiceRoom) => {
    if ((room.participantCount ?? 0) >= VOICE_MAX_ROOM_SIZE) {
      showToast('房间已满');
      return;
    }
    // 未登录用户以访客身份进入（服务端分配负数 id，显示"未登录-N"）
    voice.join(room.id, room.name);
  };

  if (voice.inRoom) {
    return <VoiceRoomView rooms={rooms} />;
  }

  return <VoiceRoomList rooms={rooms} loading={loading} onJoin={handleJoin} onRefresh={refreshRooms} />;
}
