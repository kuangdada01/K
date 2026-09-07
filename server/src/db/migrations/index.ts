/**
 * ============================================================
 * 版本化数据库迁移（执行器）
 * ============================================================
 * 每个迁移一个文件存放于本目录（001-*.ts …），按 id 升序执行。
 * 使用 schema_migrations 表记录已执行的迁移版本。
 * 每个迁移的 up() 内部保持幂等（已存在则跳过），保证新老数据库都安全。
 * 新增迁移时追加并递增 id（新建 025-*.ts），禁止修改已发布的迁移。
 */

import type Database from 'better-sqlite3';
import { logger } from '../../lib/logger';
import migration001 from './001-comments-parent-id';
import migration002 from './002-posts-image-url-json';
import migration003 from './003-messages-image-url';
import migration004 from './004-users-role';
import migration005 from './005-users-email-verified';
import migration006 from './006-posts-close-comments';
import migration007 from './007-posts-pinned';
import migration008 from './008-posts-video-url';
import migration009 from './009-posts-video-cover';
import migration010 from './010-posts-share-count';
import migration011 from './011-posts-repost-count';
import migration012 from './012-messages-quoted-message-id';
import migration013 from './013-timestamps-iso-utc';
import migration014 from './014-shares-table';
import migration015 from './015-bookmarks-table';
import migration016 from './016-reposts-table';
import migration017 from './017-post-tags-table';
import migration018 from './018-private-media-to-uploads-private';
import migration019 from './019-users-banned-until';
import migration020 from './020-voice-rooms';
import migration021 from './021-users-token-version';
import migration022 from './022-performance-indexes';
import migration023 from './023-voice-room-chat';
import migration024 from './024-voice-rooms-drop-creator-fk';
import type { Migration } from './helpers';

export type { Migration };
export { tableExists, hasColumn, addColumnIfMissing } from './helpers';

/** 迁移列表（按 id 顺序执行，新增迁移时追加并递增 id） */
export const migrations: Migration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
  migration007,
  migration008,
  migration009,
  migration010,
  migration011,
  migration012,
  migration013,
  migration014,
  migration015,
  migration016,
  migration017,
  migration018,
  migration019,
  migration020,
  migration021,
  migration022,
  migration023,
  migration024,
];

/** 迁移记录表 */
export function ensureMigrationTable(db: InstanceType<typeof Database>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);
}

/** 执行未应用的迁移（每个迁移在事务中执行并记录） */
export function applyMigrations(db: InstanceType<typeof Database>): void {
  ensureMigrationTable(db);
  const applied = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as { id: number }[]).map((r) => r.id)
  );
  const record = db.prepare('INSERT INTO schema_migrations (id, name) VALUES (?, ?)');
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      m.up(db);
      record.run(m.id, m.name);
    })();
    logger.info(`[db] 迁移已应用: ${m.id} ${m.name}`);
  }
}
