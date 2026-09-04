/**
 * ============================================================
 * 数据库初始化模块
 * ============================================================
 * 数据库类型: SQLite (通过 better-sqlite3 驱动)
 * 数据库文件: k.db (位于 server 目录下)
 *
 * 功能:
 * 1. 初始化数据库连接，启用 WAL 模式和外键约束
 * 2. 创建所有数据表（db/schema.ts）
 * 3. 执行数据库迁移（db/migrations.ts）
 * 4. 初始化管理员账号
 */

import Database from 'better-sqlite3';
import { env, PATHS } from '../config';
import { createSchema } from './schema';
import { applyMigrations } from './migrations';

// ============================================================
// 数据库连接配置
// ============================================================

/** 创建数据库连接实例（数据库文件路径: server/k.db） */
const db: InstanceType<typeof Database> = new Database(PATHS.db);

// ============================================================
// 数据库性能优化配置
// ============================================================

/**
 * WAL (Write-Ahead Logging) 模式
 * 优势: 读写可以并发进行，提升多用户场景下的性能
 */
db.pragma('journal_mode = WAL');

/** 写锁竞争时等待而非立即报 SQLITE_BUSY（多进程/测试并行场景的纵深防御） */
db.pragma('busy_timeout = 5000');

/**
 * 启用外键约束
 * 确保数据完整性，删除关联数据时自动级联删除
 */
db.pragma('foreign_keys = ON');

// ============================================================
// 建表与迁移
// ============================================================

createSchema(db);
applyMigrations(db);

// ============================================================
// 管理员账号初始化
// ============================================================

/**
 * 确保指定邮箱的用户拥有管理员权限
 * 注意: 这里只是更新角色，不创建用户
 * 管理员需要先通过正常注册流程创建账号
 */
const adminEmail = env.ADMIN_EMAIL || '';
const adminUser = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);
if (adminUser) {
  db.prepare('UPDATE users SET role = ? WHERE email = ?').run('admin', adminEmail);
}

export default db;
