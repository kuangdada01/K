import { addColumnIfMissing } from './helpers';
import type { Migration } from './helpers';

const migration: Migration = {
  id: 39,
  name: 'messages.file',
  up: (db) => {
    // 私信文件消息（2026-10-23）。
    //  · file_url：uploads_private 里的**存储文件名**（`msg_<ts>_<hex>.<ext>`），
    //    对外由 serializers/message 改写成鉴权地址 `/api/messages/:id/media`；
    //  · file_name：用户看到的原始名（下载时的保存名，中文原样存）；
    //  · file_size：字节数（UI 格式化成 KB/MB，避免客户端再 HEAD 一次拿长度）；
    //  · file_mime：服务端按扩展名判定的 MIME（不信客户端送的类型）。
    //
    // 与 image_url / audio_url **三者互斥**：一条消息只带一个附件
    // （发送服务端会拒绝同时带多个，客户端也只允许一个文件一条消息）。
    addColumnIfMissing(db, 'messages', 'file_url', 'file_url TEXT');
    addColumnIfMissing(db, 'messages', 'file_name', 'file_name TEXT');
    addColumnIfMissing(db, 'messages', 'file_size', 'file_size INTEGER DEFAULT 0');
    addColumnIfMissing(db, 'messages', 'file_mime', 'file_mime TEXT');
  },
};

export default migration;
