/**
 * ============================================================
 * 语音房间页面 (VoicePage) —— 编排层
 * ============================================================
 * Kook 式语音频道（§3.2 拆分后）：
 * - 未进房: VoiceRoomList（房间列表/创建/删除）
 * - 进房后: VoiceRoomView（成员网格/聊天面板/控制栏/录制）
 * 实时逻辑全部在 VoiceContext（WS 信令 + WebRTC Mesh，应用级、切页不断开）。
 *
 * 进房方式（2026-10 定稿）：点击「加入」**立即切入房间视图**，连接在房内
 * 静默进行 —— 房间框架（房名/成员/聊天/控制栏）直接呈现，连接进度由
 * 头部状态行表达（connecting 显示「正在连接…」），不再是整屏加载或在
 * 列表页等待。聊天历史由 useVoiceChatStore 在进房时后台预拉，进场时
 * 通常已就绪。
 *
 * 本层保留房间列表数据与轮询（进房期间仍 10s 刷新：人数徽标与
 * VoiceRoomView 的"清空聊天"权限依赖当前房间 isCreator，与拆分前
 * 同一数据源同一时刻）；TTS/聊天/控制栏等已拆入子组件与 useChatTTS。
 * ============================================================
 */

import { useCallback, useEffect, useState } from 'react';
import { useVoice } from '../context/VoiceContext';
import { listVoiceRooms } from '../api/voice';
import { pruneRoomOwnerTokens } from '../voice/roomOwnership';
import { showToast } from '../components/ui/Toast';
import VoiceRoomList from './voice/VoiceRoomList';
import VoiceRoomView from './voice/VoiceRoomView';
import type { VoiceRoom } from '../types';
import { VOICE_MAX_ROOM_SIZE } from '@k/shared';

export default function VoicePage() {
  const voice = useVoice();

  const [rooms, setRooms] = useState<VoiceRoom[]>([]);
  const [loading, setLoading] = useState(true);

  /**
   * 落地房间列表，并顺带裁剪本地「访客房间所有权令牌」表。
   * 房间列表每次轮询都会回来 —— 借它清理已消失房间的令牌，
   * 这样即便某次删除请求失败，本地也不会无限堆积令牌。
   */
  const applyRooms = useCallback((list: VoiceRoom[]) => {
    setRooms(list);
    pruneRoomOwnerTokens(list.map((r) => r.id));
  }, []);

  const refreshRooms = useCallback(() => {
    listVoiceRooms()
      .then((res) => applyRooms(res.rooms || []))
      .catch(() => {
        /* 静默失败，保留下次刷新 */
      });
  }, [applyRooms]);

  useEffect(() => {
    listVoiceRooms()
      .then((res) => applyRooms(res.rooms || []))
      .catch(() => setRooms([]))
      .finally(() => setLoading(false));
  }, [applyRooms]);

  // 进房期间轮询房间列表（人数徽标实时化）；会话结束后刷新一次
  useEffect(() => {
    if (!voice.inRoom) return;
    const timer = window.setInterval(() => {
      // 后台标签跳过：WebRTC 音频照常（产品行为），列表徽标无需在不可见时刷新
      if (document.hidden) return;
      void refreshRooms();
    }, 10_000);
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

  // 点击「加入」立即切入房间视图（原行为）：连接在房内静默进行 ——
  // 房间框架直接呈现，进度由 VoiceRoomView 头部的「正在连接…」表达
  if (voice.inRoom) {
    return <VoiceRoomView rooms={rooms} />;
  }

  return <VoiceRoomList rooms={rooms} loading={loading} onJoin={handleJoin} onRefresh={refreshRooms} />;
}
