import type { Migration } from './helpers';

const migration: Migration = {
  id: 36,
  name: 'media_jobs_file_path_index',
  up: (db) => {
    // /video-temp/status 按 file_path 查最近一次任务（客户端上传期间每几秒轮询）。
    // 此前只有 idx_media_jobs_status，file_path 查询随上传历史累积退化为全表扫描
    // —— better-sqlite3 同步执行，扫表期间整个事件循环停摆（SSE/语音信令同循环）。
    // 配套的旧行收敛（只删终态行）见 lib/video/queue 的 pruneFinishedMediaJobs。
    db.exec('CREATE INDEX IF NOT EXISTS idx_media_jobs_file_path ON media_jobs(file_path)');
  },
};

export default migration;
