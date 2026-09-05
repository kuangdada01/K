/**
 * ============================================================
 * 数据库查询辅助（db/helpers）
 * ============================================================
 * 收敛仓库层重复的 COUNT(*) 计数与"未登录用户状态哨兵"逻辑，
 * 替换散落在各 repo 的 `(prepare(...).get(...) as { count: number }).count` 样板。
 */

import { stmt } from './connection';

/** COUNT(*) 查询辅助：返回计数值（查询无结果时返回 0） */
export function count(sql: string, ...params: unknown[]): number {
  const row = stmt(sql).get(...params) as { count: number } | undefined;
  return row?.count ?? 0;
}

/** 未登录用户状态哨兵值：EXISTS 状态列用 -1 恒假（与历史"登录/未登录"两套 SQL 行为一致） */
export function uid(userId: number | undefined): number {
  return userId ?? -1;
}

/**
 * LIKE 通配符转义：\ % _ 全部转义，配合 SQL 里的 ESCAPE '\' 使用。
 * 仓库层统一走此函数，防止各处转义集不一致（漏转 \ 时含反斜杠的输入可破坏转义）
 */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, '\\$&');
}
