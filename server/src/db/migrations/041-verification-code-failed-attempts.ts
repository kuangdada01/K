import { addColumnIfMissing } from './helpers';
import type { Migration } from './helpers';

const migration: Migration = {
  id: 41,
  name: 'verification-code.failed-attempts',
  up: (db) => {
    // 验证码防撞码（2026-10-25 安全审查）：findValidCode 此前不计失败次数，
    // 6 位码在攻击者轮换 IP 时可绕过「按 IP 的登录限流」逐次试错。
    // 现每次校验失败 +1（auth.repo.registerCodeFailure），累计达
    // MAX_CODE_FAILED_ATTEMPTS 即删除该邮箱全部未过期验证码（作废重发）。
    addColumnIfMissing(
      db,
      'verification_codes',
      'failed_attempts',
      'failed_attempts INTEGER NOT NULL DEFAULT 0'
    );
  },
};

export default migration;
