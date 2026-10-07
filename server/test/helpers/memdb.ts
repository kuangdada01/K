/**
 * 测试辅助：内存数据库
 */

import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema';
import { applyMigrations } from '../../src/db/migrations';

export type MemDb = InstanceType<typeof Database>;

export function createMemoryDb(): MemDb {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  applyMigrations(db);
  return db;
}
