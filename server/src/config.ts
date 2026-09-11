/**
 * ============================================================
 * 服务端配置模块（环境变量校验 + 统一路径常量）
 * ============================================================
 * - 用 zod 在启动时校验环境变量，配置错误立即失败（fail fast）
 * - PATHS 集中管理所有磁盘路径，杜绝散落的
 *   path.join(__dirname, '..', '..', ...) 拼接（src/dist 路径差异是已知坑）
 *
 * 注意: 本模块自身会先加载 .env（import 顺序无关），index.ts 中的
 * dotenv.config() 保留仅为双保险（dotenv 默认不覆盖已存在的变量）。
 */

import path from 'path';
import dotenv from 'dotenv';
import { z } from 'zod';

// 必须在任何 process.env 读取之前执行：ESM/CJS 的 import 提升会先求值依赖模块，
// 若依赖 index.ts 里的 dotenv.config()，这里读到的是未加载 .env 的空环境
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

/** 环境变量 schema（宽松默认值；JWT_SECRET 无默认值——未配置一律拒绝启动，防止生产用公开的 dev 密钥） */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  JWT_SECRET: z.string().min(1, 'JWT_SECRET 未配置：请在 .env 或环境变量中设置强密钥，服务拒绝启动'),
  ALLOWED_ORIGINS: z.string().optional(),
  ADMIN_EMAIL: z.string().optional(),
  // 服务端前有反向代理（nginx）时置为非空：语音 WS 访客 IP 改从 x-forwarded-for 读取，
  // 未配置则只信任 TCP 对端地址（直连场景防客户端伪造）
  TRUST_PROXY: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  FFMPEG_PATH: z.string().optional(),
  FFPROBE_PATH: z.string().optional(),
  // 语音房间 TURN 中继（可选；默认仅 STUN，P2P 打不通时再配）
  VOICE_TURN_URL: z.string().optional(),
  VOICE_TURN_USERNAME: z.string().optional(),
  VOICE_TURN_CREDENTIAL: z.string().optional(),
  // App 更新检测：配置后 /api/app/version 返回最新版本信息（未配置则视为无更新）
  APP_VERSION: z.string().optional(),
  APP_APK_URL: z.string().optional(),
  APP_UPDATE_NOTES: z.string().optional(),
  // 数据库文件路径覆盖（e2e 测试用独立库文件，避免写入开发/生产 k.db）
  DB_PATH: z.string().optional(),
  // 上传文件根目录覆盖（测试用独立目录，避免测试向真实 uploads/uploads_private 写文件）。
  // 未配置时沿用 server 根目录 —— 生产行为完全不变。
  UPLOADS_DIR: z.string().optional(),
  // 管理员一次性引导：仅当取值为 1/true/yes/on 时，启动才允许按 ADMIN_EMAIL 提权。
  // 不设置即**不提权**（历史行为是「配了 ADMIN_EMAIL 就自动提权」，属静默提权路径，
  // 见 lib/admin-bootstrap.ts 的说明）。
  ADMIN_BOOTSTRAP: z.string().optional(),
});

/** 校验并导出环境变量（启动时执行一次） */
export const env = envSchema.parse(process.env);

// §4.4：生产环境 JWT_SECRET 过短时告警（不阻断启动；fail-fast 已由 envSchema 保证必填）
if (env.NODE_ENV === 'production' && env.JWT_SECRET.length < 16) {
  console.warn('[config] 警告：JWT_SECRET 长度不足 16 位，建议使用强随机密钥（如 openssl rand -base64 48）');
}

// ============================================================
// 路径常量
// ============================================================

/** server 目录（本文件位于 src/config.ts，'..' 即 server 根；编译到 dist/ 后同理） */
export const SERVER_ROOT = path.join(__dirname, '..');

/**
 * 用户上传文件的根目录（其下固定为 uploads/ 与 uploads_private/ 两个子目录）。
 *
 * 默认即 server 根 —— 生产与开发行为与历史完全一致。
 * UPLOADS_DIR 覆盖供测试使用：服务端测试与 e2e 若共用真实 uploads/，
 * 每次运行都会在 express 对外的媒体目录里留下文件（实测 uploads_private
 * 已累积 34 个测试孤儿），且并行 worker 互相看到对方的文件导致断言不稳定。
 */
export const UPLOADS_ROOT = env.UPLOADS_DIR ? path.resolve(env.UPLOADS_DIR) : SERVER_ROOT;

export const PATHS = {
  /** 上传文件根目录: <UPLOADS_ROOT>/uploads */
  uploads: path.join(UPLOADS_ROOT, 'uploads'),
  /** 临时视频目录: <UPLOADS_ROOT>/uploads/temp（发布前预览） */
  uploadsTemp: path.join(UPLOADS_ROOT, 'uploads', 'temp'),
  /** 头像目录: <UPLOADS_ROOT>/uploads/avatars */
  avatars: path.join(UPLOADS_ROOT, 'uploads', 'avatars'),
  /**
   * 私密内容目录: <UPLOADS_ROOT>/uploads_private（私密图片 + 私信图片）
   * 不在 /uploads 静态服务范围内，只能通过鉴权接口按归属下发
   */
  uploadsPrivate: path.join(UPLOADS_ROOT, 'uploads_private'),
  /** 图书数据目录: server/books */
  books: path.join(SERVER_ROOT, 'books'),
  /** 数据库文件: server/k.db（可设 DB_PATH 环境变量覆盖，如 e2e 测试指向独立库） */
  db: env.DB_PATH ? path.resolve(env.DB_PATH) : path.join(SERVER_ROOT, 'k.db'),
  /** 前端构建产物目录: client/dist */
  clientDist: path.join(SERVER_ROOT, '..', 'client', 'dist'),
  /** 音乐目录: client/public/music */
  music: path.join(SERVER_ROOT, '..', 'client', 'public', 'music'),
  /** .env 文件位置: 项目根目录 */
  envFile: path.join(SERVER_ROOT, '..', '.env'),
} as const;
