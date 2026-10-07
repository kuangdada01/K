/**
 * ============================================================
 * 管理员引导开关测试（lib/admin-bootstrap —— 4.5 权限项）
 * ============================================================
 * 历史行为是「配了 ADMIN_EMAIL 就自动提权」：邮箱写错、或旧管理员被删除后
 * 该邮箱被释放，谁注册到它谁就在下一次重启时变成管理员（静默提权）。
 * 现在改为只有显式 `ADMIN_BOOTSTRAP=1` 的那一次启动才提权。
 *
 * 这里锁住开关的取值语义 —— 尤其是「只有明确表示才开启」：
 * 任何无法识别的值都必须是**关**（安全默认）。
 */

import { describe, it, expect } from 'vitest';
import { isAdminBootstrapEnabled } from '../src/lib/admin-bootstrap';

describe('isAdminBootstrapEnabled', () => {
  it('未设置 / 空串 → 关闭（安全默认：不提权）', () => {
    expect(isAdminBootstrapEnabled(undefined)).toBe(false);
    expect(isAdminBootstrapEnabled('')).toBe(false);
    expect(isAdminBootstrapEnabled('   ')).toBe(false);
  });

  it('1 / true / yes / on（含大小写与空白）→ 开启', () => {
    for (const v of ['1', 'true', 'TRUE', 'True', 'yes', 'YES', 'on', 'ON', ' 1 ', ' true ']) {
      expect(isAdminBootstrapEnabled(v), `"${v}" 应视为开启`).toBe(true);
    }
  });

  it('★ 无法识别的值一律视为关闭（防「填了个像真的值就悄悄提权」）', () => {
    for (const v of ['0', 'false', 'no', 'off', '2', 'y', 'enable', 'yes please', 'true-ish', '-1']) {
      expect(isAdminBootstrapEnabled(v), `"${v}" 应视为关闭`).toBe(false);
    }
  });
});
