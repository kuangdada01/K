/**
 * ============================================================
 * 版本化数据库迁移
 * ============================================================
 * 使用 schema_migrations 表记录已执行的迁移版本。
 * 每个迁移的 up() 内部保持幂等（已存在则跳过），保证新老数据库都安全。
 * 新增迁移时追加并递增 id，禁止修改已发布的迁移。
 */

import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { extractTags } from '@k/shared';
import { PATHS, SERVER_ROOT } from '../config';
import { logger } from '../lib/logger';

type Migration = { id: number; name: string; up: (db: InstanceType<typeof Database>) => void };

/** 判断表是否存在 */
function tableExists(db: InstanceType<typeof Database>, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

/** 判断列是否存在（替代历史 try/catch SELECT 探测方式） */
function hasColumn(db: InstanceType<typeof Database>, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some(c => c.name === column);
}

/** ALTER TABLE 添加列（仅当不存在时） */
function addColumnIfMissing(db: InstanceType<typeof Database>, table: string, column: string, ddl: string): void {
  if (!tableExists(db, table) || hasColumn(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

/** 迁移列表（按 id 顺序执行，新增迁移时追加并递增 id） */
export const migrations: Migration[] = [
  {
    id: 1,
    name: 'comments.parent_id',
    up: (db) => {
      addColumnIfMissing(db, 'comments', 'parent_id', 'parent_id INTEGER DEFAULT NULL REFERENCES comments(id) ON DELETE CASCADE');
    },
  },
  {
    id: 2,
    name: 'posts.image_url_json',
    up: (db) => {
      if (!tableExists(db, 'posts')) return;
      const sample = db.prepare('SELECT image_url FROM posts LIMIT 1').get() as { image_url: string } | undefined;
      if (sample && !sample.image_url.startsWith('[')) {
        const posts = db.prepare('SELECT id, image_url FROM posts').all() as { id: number; image_url: string }[];
        const update = db.prepare('UPDATE posts SET image_url = ? WHERE id = ?');
        for (const p of posts) {
          update.run(JSON.stringify([p.image_url]), p.id);
        }
      }
    },
  },
  {
    id: 3,
    name: 'messages.image_url',
    up: (db) => {
      addColumnIfMissing(db, 'messages', 'image_url', 'image_url TEXT');
    },
  },
  {
    id: 4,
    name: 'users.role',
    up: (db) => {
      addColumnIfMissing(db, 'users', 'role', "role TEXT DEFAULT 'user'");
    },
  },
  {
    id: 5,
    name: 'users.email_verified',
    up: (db) => {
      addColumnIfMissing(db, 'users', 'email_verified', 'email_verified INTEGER DEFAULT 0');
    },
  },
  {
    id: 6,
    name: 'posts.close_comments',
    up: (db) => {
      addColumnIfMissing(db, 'posts', 'close_comments', 'close_comments INTEGER DEFAULT 0');
    },
  },
  {
    id: 7,
    name: 'posts.pinned',
    up: (db) => {
      addColumnIfMissing(db, 'posts', 'pinned', 'pinned INTEGER DEFAULT 0');
    },
  },
  {
    id: 8,
    name: 'posts.video_url',
    up: (db) => {
      addColumnIfMissing(db, 'posts', 'video_url', 'video_url TEXT DEFAULT NULL');
    },
  },
  {
    id: 9,
    name: 'posts.video_cover',
    up: (db) => {
      addColumnIfMissing(db, 'posts', 'video_cover', 'video_cover TEXT DEFAULT NULL');
    },
  },
  {
    id: 10,
    name: 'posts.share_count',
    up: (db) => {
      addColumnIfMissing(db, 'posts', 'share_count', 'share_count INTEGER DEFAULT 0');
    },
  },
  {
    id: 11,
    name: 'posts.repost_count',
    up: (db) => {
      addColumnIfMissing(db, 'posts', 'repost_count', 'repost_count INTEGER DEFAULT 0');
    },
  },
  {
    id: 12,
    name: 'messages.quoted_message_id',
    up: (db) => {
      addColumnIfMissing(db, 'messages', 'quoted_message_id', 'quoted_message_id INTEGER DEFAULT NULL');
    },
  },
  {
    id: 13,
    name: 'timestamps_iso_utc',
    up: (db) => {
      // 历史数据格式 'YYYY-MM-DD HH:MM:SS' → ISO-8601 UTC 'YYYY-MM-DDTHH:MM:SS.000Z'
      // GLOB 精确匹配旧格式，避免重复转换或误伤已有 ISO 值
      const LEGACY = '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]';
      const tables: { table: string; column: string }[] = [
        { table: 'users', column: 'created_at' },
        { table: 'verification_codes', column: 'created_at' },
        { table: 'announcements', column: 'created_at' },
        { table: 'announcement_reads', column: 'read_at' },
        { table: 'posts', column: 'created_at' },
        { table: 'likes', column: 'created_at' },
        { table: 'comments', column: 'created_at' },
        { table: 'messages', column: 'created_at' },
        { table: 'notifications', column: 'created_at' },
        { table: 'comment_likes', column: 'created_at' },
        { table: 'friends', column: 'created_at' },
        { table: 'private_images', column: 'created_at' },
        { table: 'shares', column: 'created_at' },
        { table: 'bookmarks', column: 'created_at' },
        { table: 'reposts', column: 'created_at' },
        { table: 'schema_migrations', column: 'applied_at' },
      ];
      for (const { table, column } of tables) {
        if (!tableExists(db, table) || !hasColumn(db, table, column)) continue;
        db.prepare(
          `UPDATE ${table} SET ${column} = replace(${column}, ' ', 'T') || '.000Z' WHERE ${column} GLOB ?`
        ).run(LEGACY);
      }
    },
  },
  {
    id: 14,
    name: 'shares_table',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS shares (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          post_id INTEGER NOT NULL,
          created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          UNIQUE(user_id, post_id),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_shares_post_id ON shares(post_id);
      `);
    },
  },
  {
    id: 15,
    name: 'bookmarks_table',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS bookmarks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          post_id INTEGER NOT NULL,
          created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          UNIQUE(user_id, post_id),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_bookmarks_user_id ON bookmarks(user_id);
        CREATE INDEX IF NOT EXISTS idx_bookmarks_post_id ON bookmarks(post_id);
      `);
    },
  },
  {
    id: 16,
    name: 'reposts_table',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS reposts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          post_id INTEGER NOT NULL,
          created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          UNIQUE(user_id, post_id),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_reposts_user_id ON reposts(user_id);
        CREATE INDEX IF NOT EXISTS idx_reposts_post_id ON reposts(post_id);
      `);
    },
  },
  {
    id: 17,
    name: 'post_tags_table',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS post_tags (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          post_id INTEGER NOT NULL,
          tag TEXT NOT NULL,
          created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          UNIQUE(post_id, tag),
          FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_post_tags_tag ON post_tags(tag);
        CREATE INDEX IF NOT EXISTS idx_post_tags_post_id ON post_tags(post_id);
      `);
      // 回填：解析存量帖子 description 中的 #话题（幂等，UNIQUE 冲突时忽略）
      if (tableExists(db, 'posts')) {
        const posts = db.prepare('SELECT id, description FROM posts').all() as { id: number; description: string | null }[];
        const insert = db.prepare('INSERT OR IGNORE INTO post_tags (post_id, tag) VALUES (?, ?)');
        const insertAll = db.transaction((rows: { id: number; tags: string[] }[]) => {
          for (const row of rows) {
            for (const tag of row.tags) insert.run(row.id, tag);
          }
        });
        const rows = posts
          .map(p => ({ id: p.id, tags: extractTags(p.description || '') }))
          .filter(r => r.tags.length > 0);
        if (rows.length > 0) insertAll(rows);
      }
    },
  },
  {
    id: 18,
    name: 'private_media_to_uploads_private',
    up: (db) => {
      // 私密图片/私信图片从公开静态目录（uploads、uploads/avatars）
      // 搬移到 uploads_private，image_url 改存纯文件名，
      // 之后只能经鉴权接口下发（GET /api/users/me/private-images/:id/file、GET /api/messages/media/:id）
      fs.mkdirSync(PATHS.uploadsPrivate, { recursive: true });

      const moveToPrivate = (oldUrl: string): string => {
        const name = path.basename(oldUrl);
        const from = path.join(SERVER_ROOT, oldUrl.replace(/^\//, ''));
        const to = path.join(PATHS.uploadsPrivate, name);
        try {
          if (fs.existsSync(from)) fs.renameSync(from, to);
        } catch { /* 文件缺失/被占用时跳过移动，仅改写记录 */ }
        return name;
      };

      if (tableExists(db, 'private_images')) {
        const rows = db.prepare(
          "SELECT id, image_url FROM private_images WHERE image_url LIKE '/uploads/%'"
        ).all() as { id: number; image_url: string }[];
        const upd = db.prepare('UPDATE private_images SET image_url = ? WHERE id = ?');
        for (const r of rows) {
          upd.run(moveToPrivate(r.image_url), r.id);
        }
      }

      if (tableExists(db, 'messages')) {
        const rows = db.prepare(
          "SELECT id, image_url FROM messages WHERE image_url LIKE '/uploads/%'"
        ).all() as { id: number; image_url: string }[];
        const upd = db.prepare('UPDATE messages SET image_url = ? WHERE id = ?');
        for (const r of rows) {
          upd.run(moveToPrivate(r.image_url), r.id);
        }
      }
    },
  },
  {
    id: 19,
    name: 'users.banned_until',
    up: (db) => {
      addColumnIfMissing(db, 'users', 'banned_until', 'banned_until TEXT DEFAULT NULL');
    },
  },
  {
    id: 20,
    name: 'voice_rooms',
    up: (db) => {
      // 语音房间表（新库已由 createSchema 直接建表，此处为老库升级，幂等）
      db.exec(`
        CREATE TABLE IF NOT EXISTS voice_rooms (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          description TEXT DEFAULT '',
          creator_id INTEGER NOT NULL,
          created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          FOREIGN KEY (creator_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_voice_rooms_creator ON voice_rooms(creator_id);
      `);
    },
  },
  {
    id: 21,
    name: 'users.token_version',
    up: (db) => {
      // 令牌版本：改密/重置密码时 +1，使已签发的 JWT（7 天有效期）全部失效
      addColumnIfMissing(db, 'users', 'token_version', 'token_version INTEGER NOT NULL DEFAULT 0');
    },
  },
  {
    id: 22,
    name: 'performance_indexes',
    up: (db) => {
      // P1 修复：为高频查询路径补齐 6 个关键索引，消除全表扫描。
      // 各表可能不存在（迁移测试用最小 schema 运行），逐表守卫保证幂等安全。
      if (tableExists(db, 'notifications')) {
        // 管理删帖/删评论时清理通知（admin.repo.ts:103、comment.repo.ts:83 的递归 CTE）
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_notifications_post_id ON notifications(post_id);
          CREATE INDEX IF NOT EXISTS idx_notifications_comment_id ON notifications(comment_id);
        `);
      }
      if (tableExists(db, 'verification_codes')) {
        // 每次登录/发码都按 email 查验证码（auth.repo.ts:27-49）
        db.exec(`CREATE INDEX IF NOT EXISTS idx_verification_codes_email ON verification_codes(email);`);
      }
      if (tableExists(db, 'messages')) {
        // 会话列表对每个 partner 跑相关子查询（message.repo.ts:34-62）
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_messages_sender_receiver_created ON messages(sender_id, receiver_id, created_at);
          CREATE INDEX IF NOT EXISTS idx_messages_receiver_sender_read ON messages(receiver_id, sender_id, read);
        `);
      }
      if (tableExists(db, 'comments')) {
        // 评论树递归展开（comment.repo.ts:84-91）
        db.exec(`CREATE INDEX IF NOT EXISTS idx_comments_parent_id ON comments(parent_id);`);
      }
      // 顺带修复：清理过期验证码（表只增不减；expires 存 ISO-8601，用 datetime 比较）
      if (tableExists(db, 'verification_codes')) {
        db.exec(`DELETE FROM verification_codes WHERE datetime(expires) < datetime('now')`);
      }
    },
  },
  {
    id: 23,
    name: 'voice_room_chat',
    up: (db) => {
      // 语音房间文本聊天 + 创建者快照（guest 可建房，建房间时把创建者信息冗余到房间表，
      // 不再依赖 JOIN users —— 游客创建者没有 users 行；creator_id 仍保留 FK 语义）
      if (tableExists(db, 'voice_rooms')) {
        addColumnIfMissing(db, 'voice_rooms', 'creator_name', "creator_name TEXT DEFAULT ''");
        addColumnIfMissing(db, 'voice_rooms', 'creator_avatar', 'creator_avatar TEXT DEFAULT NULL');
        // creator_ip 仅用于校验游客房主身份（guestIds 只在内存中，重启即丢），永不返回给前端
        addColumnIfMissing(db, 'voice_rooms', 'creator_ip', 'creator_ip TEXT DEFAULT NULL');
        // 回填存量房间的创建者快照（仅限已登录创建者；游客创建者不存在存量）
        db.exec(`
          UPDATE voice_rooms SET
            creator_name = COALESCE((SELECT username FROM users WHERE users.id = voice_rooms.creator_id), ''),
            creator_avatar = (SELECT avatar FROM users WHERE users.id = voice_rooms.creator_id)
          WHERE creator_id > 0 AND (creator_name IS NULL OR creator_name = '');
        `);
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS voice_room_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          room_id INTEGER NOT NULL,
          sender_id INTEGER NOT NULL,
          username TEXT NOT NULL,
          avatar TEXT DEFAULT NULL,
          content TEXT NOT NULL,
          created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_voice_room_messages_room ON voice_room_messages(room_id, id);
      `);
    },
  },
  {
    id: 24,
    name: 'voice_rooms_drop_creator_fk',
    up: (db) => {
      // 语音房支持未登录访客创建后，creator_id 不再是 users 外键：
      // 访客创建者没有 users 行（且负数/0 id 都会撞外键约束，生产库
      // PRAGMA foreign_keys=ON 会拒绝写入）。房间改由"创建者/管理员显式删除"
      // 管理生命周期（与访客房、聊天记录随房清理语义一致），不再随用户删除级联。
      // 重建表结构（SQLite 无 DROP CONSTRAINT；本表无其它表的 FK 引用，
      // foreign_keys=ON 下 DROP/重建安全，applyMigrations 已在事务中包裹）。
      if (tableExists(db, 'voice_rooms')) {
        db.exec(`
          CREATE TABLE voice_rooms_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            creator_id INTEGER NOT NULL,
            creator_name TEXT DEFAULT '',
            creator_avatar TEXT DEFAULT NULL,
            creator_ip TEXT DEFAULT NULL,
            created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
          );
          INSERT INTO voice_rooms_new (id, name, description, creator_id, creator_name, creator_avatar, creator_ip, created_at)
            SELECT id, name, description, creator_id, creator_name, creator_avatar, creator_ip, created_at FROM voice_rooms;
          DROP TABLE voice_rooms;
          ALTER TABLE voice_rooms_new RENAME TO voice_rooms;
          CREATE INDEX IF NOT EXISTS idx_voice_rooms_creator ON voice_rooms(creator_id);
        `);
      }
    },
  },
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
    (db.prepare('SELECT id FROM schema_migrations').all() as { id: number }[]).map(r => r.id)
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
