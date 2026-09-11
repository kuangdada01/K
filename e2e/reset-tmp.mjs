/**
 * 重置 e2e 的临时库与上传目录。
 *
 * 为什么是**独立脚本 + 挂在 webServer 命令前面**，而不是写在 playwright.config.ts 顶层：
 * 配置文件会在**每个 worker 进程**里被再次求值，而 worker 是在 webServer 启动
 * **之后**才起来的。那时删除库文件在 Linux 上会成功（unlink 掉服务端正持有的
 * inode，服务端继续写已删除的文件，规格却新建一张空库）→
 * `SqliteError: no such table: verification_codes`；Windows 上因文件被占用而
 * 删除失败，所以这个坑只在 Linux CI 上暴露。
 * 挂在启动命令前则保证：只跑一次，且只可能在服务端启动**之前**。
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = path.join(import.meta.dirname, '.tmp');
fs.mkdirSync(dir, { recursive: true });

const removed = [];
for (const name of ['k-e2e.db', 'k-e2e.db-wal', 'k-e2e.db-shm']) {
  try {
    fs.rmSync(path.join(dir, name), { force: true });
    removed.push(name);
  } catch {
    /* Windows 上被占用时删不掉：沿用现有库（本地复用了已有服务的情况） */
  }
}
try {
  fs.rmSync(path.join(dir, 'uploads'), { recursive: true, force: true });
  removed.push('uploads/');
} catch {
  /* 同上 */
}

console.log(`[e2e] 临时库与上传目录已重置: ${removed.length ? removed.join(', ') : '(无需清理)'}`);
