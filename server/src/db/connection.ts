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

/** 仅测试使用：注入内存数据库 */
export function setDbForTests(db: InstanceType<typeof Database>): void {
  current = db;
}

/** 仅测试使用：恢复真实数据库 */
export function resetDbForTests(): void {
  current = realDb;
}
