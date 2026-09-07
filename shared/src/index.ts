/**
 * ============================================================
 * @k/shared - 前后端共享包入口
 * ============================================================
 * 主入口：常量/工具/领域类型（双端使用）。
 * zod 校验 schema 在 @k/shared/schemas 子入口（仅服务端使用——
 * CJS 包无法 tree-shake，留在主入口会把 zod 整包带进 client
 * bundle，其 allowsEval 能力检测还会被站点 CSP 拦截记录，
 * 见 schemas/index.ts 说明）。
 */

export * from './constants/voice';
export * from './utils/tag';
export * from './types';
