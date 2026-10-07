import type Database from 'better-sqlite3';

export type Migration = { id: number; name: string; up: (db: InstanceType<typeof Database>) => void };

/** 判断表是否存在 */
export function tableExists(db: InstanceType<typeof Database>, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

/** 判断列是否存在（替代历史 try/catch SELECT 探测方式） */
export function hasColumn(db: InstanceType<typeof Database>, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

/** ALTER TABLE 添加列（仅当不存在时） */
export function addColumnIfMissing(
  db: InstanceType<typeof Database>,
  table: string,
  column: string,
  ddl: string
): void {
  if (!tableExists(db, table) || hasColumn(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
