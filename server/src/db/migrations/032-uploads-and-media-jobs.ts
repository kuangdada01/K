import type { Migration } from './helpers';

const migration: Migration = {
  id: 32,
  name: 'uploads_and_media_jobs',
  up: (db) => {
    // P1-3.4：上传会话与转码任务持久化（原先只在内存 Map / Promise 链里，
    // 服务重启即丢：属主无法判定、配额统计失真、转码任务静默消失）。
    //
    // uploads：一行 = 一个临时上传会话（分片上传或 /video-temp 直传登记）。
    //  - total_chunks < 0 表示非分片会话（预览直传），无顺序/幂等语义；
    //  - consumed_at 非空表示临时文件已被 POST /video 消费（移入正式目录），
    //    保留一行便于追溯，配额统计排除已消费会话；
    //  - 迁移不回填：部署前已存在的临时文件没有可靠属主，不凭文件名猜归属
    //    （未知属主文件由 TTL 清理隔离回收，不能被新请求接管）。
    db.exec(`
      CREATE TABLE IF NOT EXISTS uploads (
        upload_id TEXT PRIMARY KEY,
        owner_id INTEGER NOT NULL,
        total_chunks INTEGER NOT NULL DEFAULT -1,
        next_chunk INTEGER NOT NULL DEFAULT 0,
        received_bytes INTEGER NOT NULL DEFAULT 0,
        bytes INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        consumed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_uploads_owner ON uploads(owner_id);
    `);
    // 分片确认记录：(upload_id, chunk_index) → 长度与 SHA-256。
    // 重启后重放幂等比对仍可用（内存版只有进程内 Map，P0 时引入）。
    db.exec(`
      CREATE TABLE IF NOT EXISTS upload_chunks (
        upload_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        PRIMARY KEY (upload_id, chunk_index)
      );
    `);
    // media_jobs：转码任务（kind 预留扩展）。
    //  - status: queued / running / ready / failed；
    //  - lease_expires_at：running 的租约；进程重启后租约过期的任务重新排队
    //    （转码操作可重复执行：ensurePlayableVideo 对已可播文件是 no-op）；
    //  - attempts / max_attempts：失败重试上限，超限落 failed 并保留 last_error。
    db.exec(`
      CREATE TABLE IF NOT EXISTS media_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL DEFAULT 'transcode',
        file_path TEXT NOT NULL,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        lease_expires_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_media_jobs_status ON media_jobs(status);
    `);
  },
};

export default migration;
