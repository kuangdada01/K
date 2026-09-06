/**
 * ============================================================
 * 数据库初始化模块（惰性单例）
 * ============================================================
 * 数据库类型: SQLite (通过 better-sqlite3 驱动)
 * 数据库文件: k.db (位于 server 目录下，可用 DB_PATH 环境变量覆盖)
 *
 * 惰性初始化：模块 import 时不再立刻打开 k.db，首次真实访问才执行
 * 连接/WAL/建表/迁移/管理员初始化。这样单测（setDbForTests 注入内存库）
 * 从 connection.ts 一路 import 进来也不会触碰真实 k.db 文件。
 */

import Database from 'better-sqlite3';
import { env, PATHS } from '../config';
import { createSchema } from './schema';
import { applyMigrations } from './migrations';

let real: InstanceType<typeof Database> | null = null;

function init(): InstanceType<typeof Database> {
  const db = new Database(PATHS.db);

  // WAL：读写并发提升；busy_timeout：写锁竞争时等待而非立即 SQLITE_BUSY；
  // foreign_keys：删除关联数据时自动级联删除
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  createSchema(db);
  applyMigrations(db);

  // 管理员账号初始化：确保指定邮箱的用户拥有管理员权限
  // （只更新角色，不创建用户；管理员需要先通过正常注册流程创建账号）
  const adminEmail = env.ADMIN_EMAIL || '';
  const adminUser = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);
  if (adminUser) {
    db.prepare('UPDATE users SET role = ? WHERE email = ?').run('admin', adminEmail);
  }

  return db;
}

/**
 * 惰性代理单例：属性访问时才真正初始化。
 * 方法经 bind 绑定到真实实例（better-sqlite3 的原生方法不能以代理为 this 调用）。
 */
const lazyDb: InstanceType<typeof Database> = new Proxy({} as InstanceType<typeof Database>, {
  get(_target, prop) {
    if (!real) real = init();
    const value = Reflect.get(real, prop);
    return typeof value === 'function' ? value.bind(real) : value;
  },
});

export default lazyDb;
