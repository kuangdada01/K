/**
 * ============================================================
 * 数据库查询辅助（db/helpers）
 * ============================================================
 * 收敛仓库层重复的 COUNT(*) 计数与"未登录用户状态哨兵"逻辑，
 * 替换散落在各 repo 的 `(prepare(...).get(...) as { count: number }).count` 样板。
 */

import { getDb } from './connection';

/** COUNT(*) 查询辅助：返回计数值（查询无结果时返回 0） */
export function count(sql: string, ...params: unknown[]): number {
  const row = getDb()
    .prepare(sql)
    .get(...params) as { count: number } | undefined;
  return row?.count ?? 0;
}

/** 未登录用户状态哨兵值：EXISTS 状态列用 -1 恒假（与历史"登录/未登录"两套 SQL 行为一致） */
export function uid(userId: number | undefined): number {
  return userId ?? -1;
}
