import { addColumnIfMissing } from './helpers';
import type { Migration } from './helpers';

const migration: Migration = {
  id: 38,
  name: 'messages.recalled_at',
  up: (db) => {
    // 撤回改成「留痕」（2026-10-22）：以前撤回直接 DELETE，重进会话就查无此事 ——
    // 用户反馈"撤回重新进消息对话不显示，对方撤回两边都应该知道"。
    // 现在保留行、写 recalled_at，并清空内容/媒体字段（媒体文件仍会删除）：
    //  · 双方重进会话都能看到「你/对方 撤回了一条消息」；
    //  · 时间轴位置不变（行还占着原来的 created_at），与 QQ/微信一致；
    //  · content 置空 + image_url/audio_url 置 NULL，撤回的内容不会从历史接口漏出去。
    addColumnIfMissing(db, 'messages', 'recalled_at', 'recalled_at TEXT');
  },
};

export default migration;
