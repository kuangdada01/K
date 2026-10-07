/**
 * ============================================================
 * 数据库连接访问器
 * ============================================================
 * 仓库层（repositories/）通过 getDb() 获取数据库实例，
 * 生产环境默认使用真实单例（db/index.ts）；
 * 测试可通过 setDbForTests() 注入内存数据库，杜绝测试污染真实数据。
 */

import type Database from 'better-sqlite3';
import realDb from './index';

let current: InstanceType<typeof Database> = realDb;

/** 获取当前数据库实例（仓库层唯一入口） */
export function getDb(): InstanceType<typeof Database> {
  return current;
}

/**
 * 预编译语句缓存：仓库层的 SQL 全是静态字符串，better-sqlite3 对同一 SQL
 * 重复 prepare 有可测开销，这里按 db 实例缓存复用。
 * WeakMap 按实例隔离——测试通过 setDbForTests 注入内存库时，旧缓存自动失效。
 */
const stmtCache = new WeakMap<InstanceType<typeof Database>, Map<string, Database.Statement>>();

/** 获取（并缓存）预编译语句，替代 getDb().prepare(...) 的逐次编译 */
export function stmt(sql: string): Database.Statement {
  const db = getDb();
  let cache = stmtCache.get(db);
  if (!cache) {
    cache = new Map();
    stmtCache.set(db, cache);
  }
  let prepared = cache.get(sql);
  if (!prepared) {
    prepared = db.prepare(sql);
    cache.set(sql, prepared);
  }
  return prepared;
}

/** 仅测试使用：注入内存数据库 */
export function setDbForTests(db: InstanceType<typeof Database>): void {
  current = db;
}

/** 仅测试使用：恢复真实数据库 */
export function resetDbForTests(): void {
  current = realDb;
}
