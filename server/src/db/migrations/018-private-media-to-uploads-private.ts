import fs from 'fs';
import path from 'path';
import { PATHS, UPLOADS_ROOT } from '../../config';
import { tableExists } from './helpers';
import type { Migration } from './helpers';

const migration: Migration = {
  id: 18,
  name: 'private_media_to_uploads_private',
  up: (db) => {
    // 私密图片/私信图片从公开静态目录（uploads、uploads/avatars）
    // 搬移到 uploads_private，image_url 改存纯文件名，
    // 之后只能经鉴权接口下发（GET /api/users/me/private-images/:id/file、GET /api/messages/media/:id）
    fs.mkdirSync(PATHS.uploadsPrivate, { recursive: true });

    const moveToPrivate = (oldUrl: string): string => {
      const name = path.basename(oldUrl);
      const from = path.join(UPLOADS_ROOT, oldUrl.replace(/^\//, ''));
      const to = path.join(PATHS.uploadsPrivate, name);
      try {
        if (fs.existsSync(from)) fs.renameSync(from, to);
      } catch {
        /* 文件缺失/被占用时跳过移动，仅改写记录 */
      }
      return name;
    };

    if (tableExists(db, 'private_images')) {
      const rows = db
        .prepare("SELECT id, image_url FROM private_images WHERE image_url LIKE '/uploads/%'")
        .all() as { id: number; image_url: string }[];
      const upd = db.prepare('UPDATE private_images SET image_url = ? WHERE id = ?');
      for (const r of rows) {
        upd.run(moveToPrivate(r.image_url), r.id);
      }
    }

    if (tableExists(db, 'messages')) {
      const rows = db
        .prepare("SELECT id, image_url FROM messages WHERE image_url LIKE '/uploads/%'")
        .all() as { id: number; image_url: string }[];
      const upd = db.prepare('UPDATE messages SET image_url = ? WHERE id = ?');
      for (const r of rows) {
        upd.run(moveToPrivate(r.image_url), r.id);
      }
    }
  },
};

export default migration;
