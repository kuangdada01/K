/**
 * ============================================================
 * 校验 Schema 子入口（@k/shared/schemas）
 * ============================================================
 * zod schema 仅服务端运行时校验使用；client 打包 @k/shared（CJS）时
 * 无法 tree-shake，zod 会整包进前端 vendor（且 zod 的 allowsEval 能力
 * 检测会被站点 CSP 拦截并在 DevTools Issues 记录）。
 * 拆出独立子路径后：server 从 @k/shared/schemas 导入 schema，
 * 主入口 @k/shared 只保留常量/工具/类型，client bundle 不再携带 zod。
 * 导出内容与拆分前完全一致（行为不变）。
 * ============================================================
 */

export * from './common';
export * from './auth';
export * from './post';
export * from './user';
export * from './message';
export * from './admin';
export * from './voice';
