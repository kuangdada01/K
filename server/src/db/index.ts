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
import { logger } from '../lib/logger';
import { isAdminBootstrapEnabled } from '../lib/admin-bootstrap';

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

  // 管理员账号初始化（**显式一次性引导**，默认关闭）
  //
  // 历史行为：只要配了 ADMIN_EMAIL，启动时就把该邮箱的账号提升为 admin。
  // 风险是「静默提权」：若 ADMIN_EMAIL 写错、或旧管理员被删除后该邮箱被释放，
  // **谁注册到这个邮箱，谁就在下一次重启时变成管理员**，而运维侧毫无察觉。
  // 已经加过警告日志，但日志不能阻止提权发生。
  //
  // 现在改为 opt-in：只有显式设置 ADMIN_BOOTSTRAP=1 的那一次启动才会提权。
  // 引导完就应把该变量去掉（一次性），此后提权只能由现有管理员在后台操作 ——
  // 即「配置写错」不再等价于「权限泄漏」。
  const adminEmail = env.ADMIN_EMAIL || '';
  if (adminEmail) {
    const adminUser = db.prepare('SELECT id, username, role FROM users WHERE email = ?').get(adminEmail) as
      { id: number; username: string; role: string } | undefined;
    const bootstrapRequested = isAdminBootstrapEnabled(env.ADMIN_BOOTSTRAP);

    if (!adminUser) {
      // 尚未注册：提醒一次，避免「配了却没生效」长期无人察觉
      logger.info(
        `[db] ADMIN_EMAIL 已配置但尚无对应用户；该邮箱注册后需显式设置 ADMIN_BOOTSTRAP=1 重启一次才会提权`
      );
    } else if (adminUser.role === 'admin') {
      if (bootstrapRequested) {
        logger.warn('[db] ADMIN_BOOTSTRAP=1 已设置，但该账号已是管理员；引导完成后请移除该变量');
      }
    } else if (bootstrapRequested) {
      db.prepare('UPDATE users SET role = ? WHERE email = ?').run('admin', adminEmail);
      logger.warn(
        { userId: adminUser.id, username: adminUser.username },
        `[db] 已按 ADMIN_BOOTSTRAP=1 将账号提升为管理员（原角色 ${adminUser.role}）——这是显式的一次性引导，请立即移除该变量`
      );
    } else {
      // 配了 ADMIN_EMAIL 但没开引导：**不提权**，只提示如何有意为之
      logger.warn(
        { userId: adminUser.id, username: adminUser.username, role: adminUser.role },
        '[db] ADMIN_EMAIL 对应的账号不是管理员，且未设置 ADMIN_BOOTSTRAP=1，已跳过提权；' +
          '确实需要提权时请临时设置 ADMIN_BOOTSTRAP=1 重启一次，然后移除它'
      );
    }
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
