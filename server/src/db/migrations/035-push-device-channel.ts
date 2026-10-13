import type { Migration } from './helpers';
import { addColumnIfMissing } from './helpers';

const migration: Migration = {
  id: 35,
  name: 'push_device_channel',
  up: (db) => {
    /**
     * 客户端上报的「本机通知通道 id」（离线推送展示用）。
     *
     * 为什么需要它：Android 9+ 的通知栏消息**必须**带 `channel_id` 且与客户端创建的
     * NotificationChannel 完全一致，否则系统静默丢弃（接口仍返回 code=0）。
     * 而「新消息」通道在发生过"静默通道自动修复"的设备上会变成 `k_messages_v2_g2`
     * （旧通道被删除，见 SocialNotifier.messagesChannelId）——**只有设备自己知道**
     * 当前是哪一代，所以由客户端在注册设备时上报，服务端逐设备存储。
     *
     * 老库补列；新库由 createSchema 直接建好 —— 两边 DDL 必须一致。
     */
    addColumnIfMissing(db, 'push_devices', 'channel_id', 'channel_id TEXT DEFAULT NULL');
  },
};

export default migration;
