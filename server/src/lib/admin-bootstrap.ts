/**
 * ============================================================
 * 管理员引导开关（admin-bootstrap）
 * ============================================================
 * 由 db/index.ts 在初始化时使用：只有显式设置 `ADMIN_BOOTSTRAP=1` 的那一次启动，
 * 才允许按 `ADMIN_EMAIL` 把账号提升为管理员。
 *
 * 为什么要有这个开关：此前「配了 ADMIN_EMAIL 就自动提权」是一条**静默提权**路径 ——
 * 邮箱写错、或旧管理员被删除后该邮箱被释放，谁注册到它谁就在下一次重启时变成管理员。
 * 日志能事后发现，但拦不住提权本身；改成 opt-in 后，「配置写错」不再等于「权限泄漏」。
 *
 * 把判断抽成纯函数是为了能被单测直接覆盖（db/index.ts 的 init 依赖真实文件库）。
 * ============================================================
 */

/** 是否为「明确请求引导」的取值：接受 1/true/yes/on（大小写不敏感） */
export function isAdminBootstrapEnabled(raw: string | undefined): boolean {
  if (!raw) return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}
