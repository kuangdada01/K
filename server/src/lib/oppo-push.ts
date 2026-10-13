/**
 * ============================================================
 * OPPO PUSH 服务端客户端（lib/oppo-push）
 * ============================================================
 * 只做三件事，全部围绕 OPPO 官方《推送平台服务端 API》V1.9：
 *
 *  1. **鉴权**：`POST /server/v1/auth`，签名 `sha256(appKey + timestamp + masterSecret)`，
 *     换回 `auth_token`（官方有效期 24 小时），进程内缓存、到期前 5 分钟自动续；
 *  2. **单推**：`POST /server/v1/message/notification/unicast`，
 *     按 registration_id 推一条**通知栏消息**（由系统推送服务直接展示，
 *     App 被杀也能弹；点击动作是我们指定的深链，见 services/push.service）；
 *  3. **失效回执**：`GET /server/v1/feedback/fetch_invalid_regidList`，
 *     拿回系统判定已失效的 registration_id 列表（调用方负责从库里删掉），
 *     否则设备卸载/重置后库里会一直留着死 token。
 *
 * ## 为什么 auth_token 要缓存且做"单飞"
 *
 * 官方限制 token 24h 一换、且服务端**允许的时间误差只有 10 分钟**——
 * 每次发推送都重新鉴权既浪费一次往返，又更容易踩到时钟误差问题；
 * 而"单飞"（并发请求复用同一个进行中的鉴权 Promise）是因为鉴权本身要 POST，
 * 多条推送同时到达时不能各换各的（会把上一个 token 立刻作废成"待刷新"状态）。
 *
 * ## 失败语义
 *
 * 本模块**从不抛出**（除签名等编程错误外全部转成返回值/日志）：
 * 推送是"锦上添花"的旁路，任何失败都不允许影响消息本身的投递（SSE 已经先发了）。
 *  - `code=11`（Invalid AuthToken）：清缓存重试一次；
 *  - `code=10000`（Invalid Registration_id）：返回 `invalidToken=true`，
 *    调用方把该 token 从库里删掉（设备卸载/换机的常态，不是异常）；
 *  - 网络/超时/非 JSON：记一条 warn，返回失败。
 *
 * ## 与配置的关系
 *
 * `OPPO_PUSH_APP_KEY` / `OPPO_PUSH_MASTER_SECRET` 未配置时 [isOppoPushConfigured] 为 false，
 * 整个功能静默禁用（本地开发、测试、e2e 都不需要任何 OPPO 配置）。
 * `OPPO_PUSH_API_BASE` 可覆盖接口域名（默认国内正式环境）；一旦覆盖，
 * 失效回执接口一律跳过 —— 沙箱/模拟环境不该去真实反馈服务里取数据。
 */

import crypto from 'crypto';
import { env } from '../config';
import { logger } from './logger';

/** 国内正式环境（对海外设备推送用 api-intl.push.oppomobile.com，本项目不涉及） */
const DEFAULT_API_BASE = 'https://api.push.oppomobile.com';
/** 反馈服务与推送服务不同域名（见官方文档"请求地址"节） */
const FEEDBACK_ORIGIN = 'https://feedback.push.oppomobile.com';

/** 单次 HTTP 请求超时：推送是旁路，宁可放弃也不能挂住调用链 */
const HTTP_TIMEOUT_MS = 10_000;

/** auth_token 官方有效期 24h；提前 5 分钟续，规避"刚好过期"边界 */
const AUTH_TTL_MS = 24 * 3600 * 1000;
const AUTH_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** 推送默认离线 TTL：6 小时（设备断网超过该时长这条作废） */
const DEFAULT_TTL_SECONDS = 6 * 3600;

/** OPPO 通知栏消息字段长度硬限制（超出会被服务端拒绝，见官方文档"通知栏消息"节） */
const MAX_TITLE_CHARS = 50;
/** 标准样式 content 官方限 200 字；我们多截一点留余量（实际手机端只展示 50 字） */
const MAX_CONTENT_CHARS = 180;

/**
 * 桌面数字角标的归属 Activity（badge_class，= 启动 Activity 全类名）。
 * 与 services/push.service 的 MAIN_ACTIVITY 同值：点击推送和角标都落在桌面图标上。
 */
const LAUNCHER_ACTIVITY = 'top.kuangdada.k.nativeapp.MainActivity';

/**
 * ★ 默认推送通道 id（Android 9+ 的通知栏消息**必须**带 `channel_id`）。
 *
 * 官方《通知通道(Channel)适配》原文："未指定通道的情况下发出的通知将无法显示"——
 * 而且这是**静默失败**：接口照样返回 `code=0`，消息在设备端被系统丢弃、无任何回调。
 * （2026-10-08 当天真机"关闭 App 收不到通知"排查出的两道坎之一。）
 *
 * 取值 = 客户端「新消息」通道的**第一代 id**（`SocialNotifier.CHANNEL_MESSAGES`）：
 *  · 通知走它 = 和 App 内私信通知同一个通道（重要级 HIGH、有声音震动、可横幅）；
 *  · 发生过"静默通道自动修复"的设备，真实通道是 `k_messages_v2_g2`（旧通道会被删），
 *    这类设备由客户端在注册时上报自己的 id（push_devices.channel_id，0.1.16+），
 *    服务端优先用上报值 —— 本常量只服务"还没上报过的老客户端"。
 *
 * ⚠️ 客户端改「新消息」通道的基础 id 时，**必须同步改这里**（契约测试钉着两者一致）。
 */
export const DEFAULT_PUSH_CHANNEL_ID = 'k_messages_v2';

// ------------------------------------------------------------------
// 配置与就绪判断
// ------------------------------------------------------------------

export function isOppoPushConfigured(): boolean {
  // 测试环境一律视为"未配置"：单测里 `notifyUser` 的每次调用都会走到推送分支，
  // 绝不能真的发网络请求或碰数据库（sse-subscribers 等既有用例正是如此）。
  // 需要覆盖推送逻辑的测试请直接测纯函数（composePush / oppoAuthSign / repo），
  // 或 mock 掉 services/push.service —— 都不依赖真实配置。
  if (env.NODE_ENV === 'test') return false;
  return Boolean(env.OPPO_PUSH_APP_KEY && env.OPPO_PUSH_MASTER_SECRET);
}

function apiBase(): string {
  return (env.OPPO_PUSH_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, '');
}

/** 是否使用了自定义域名（自定义时跳过反馈服务：那是真实生产接口） */
function isCustomApiBase(): boolean {
  return Boolean(env.OPPO_PUSH_API_BASE && env.OPPO_PUSH_API_BASE !== DEFAULT_API_BASE);
}

// ------------------------------------------------------------------
// 鉴权
// ------------------------------------------------------------------

interface AuthCache {
  token: string;
  /** 本地判定的过期时刻（create_time + 24h - 5min） */
  expireAt: number;
}

let authCache: AuthCache | null = null;
/** 单飞：并发请求共享同一次鉴权（见文件头说明） */
let authInflight: Promise<string | null> | null = null;

/**
 * 官方签名：`sha256(appkey + timestamp + mastersecret)`（十六进制小写）。
 *
 * 单独导出是为了可单测：这是整条链路里唯一"写错就 401、且报错是
 * `code=16 Invalid Signature`"的地方，值得有一条测试钉住格式。
 */
export function oppoAuthSign(appKey: string, timestamp: number, masterSecret: string): string {
  return crypto.createHash('sha256').update(`${appKey}${timestamp}${masterSecret}`).digest('hex');
}

/** 清缓存（收到 code=11 / 主动 retry 时调用） */
function invalidateAuth(): void {
  authCache = null;
}

/**
 * 取 auth_token（缓存 + 单飞）。失败返回 null（调用方按"本次发不出去"处理）。
 *
 * `timestamp` 必须是**毫秒**时间戳（官方原文："格式为13位时间毫秒数"）。
 */
async function requestAuthToken(): Promise<string | null> {
  const appKey = env.OPPO_PUSH_APP_KEY!;
  const masterSecret = env.OPPO_PUSH_MASTER_SECRET!;
  const timestamp = Date.now();
  const body = new URLSearchParams({
    app_key: appKey,
    sign: oppoAuthSign(appKey, timestamp, masterSecret),
    timestamp: String(timestamp),
  });

  try {
    const res = await fetch(`${apiBase()}/server/v1/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const json = (await res.json()) as {
      code?: number;
      message?: string;
      data?: { auth_token?: string; create_time?: string | number } | null;
    };
    const token = json.data?.auth_token;
    if (json.code !== 0 || !token) {
      logger.warn(
        { code: json.code, message: json.message, appId: env.OPPO_PUSH_APP_ID },
        'OPPO 推送鉴权失败'
      );
      return null;
    }
    const createTime = Number(json.data?.create_time);
    const base = Number.isFinite(createTime) && createTime > 0 ? createTime : Date.now();
    authCache = { token, expireAt: base + AUTH_TTL_MS - AUTH_REFRESH_MARGIN_MS };
    logger.info({ appId: env.OPPO_PUSH_APP_ID }, 'OPPO 推送鉴权完成');
    return token;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'OPPO 推送鉴权请求失败（网络/超时）'
    );
    return null;
  }
}

export async function getAuthToken(): Promise<string | null> {
  if (!isOppoPushConfigured()) return null;
  if (authCache && Date.now() < authCache.expireAt) return authCache.token;
  if (!authInflight) {
    authInflight = requestAuthToken().finally(() => {
      authInflight = null;
    });
  }
  return authInflight;
}

// ------------------------------------------------------------------
// 单推（通知栏消息）
// ------------------------------------------------------------------

/** 一条待推送的通知栏消息（组装好的最终文案，见 services/push.service） */
export interface OppoNotificationPayload {
  title: string;
  content: string;
  /**
   * 点击动作：打开应用内页（activity）。
   *
   * `click_action_type=4` + `click_action_activity`（完整类名）+
   * `action_parameters`（JSON 字符串，会被并入启动 Intent 的 extras）。
   * 我们的 `action_parameters` 恒为 `{"deep_link":"..."}` —— 与 App 内
   * 本地通知、站内链接**同一条解析路径**（MainActivity 的 deep_link extra）。
   */
  activityClassName: string;
  /** 透传给 App 的 JSON 字符串（写入 `action_parameters`） */
  actionParameters: string;
  /**
   * 设备上报的通知通道 id（push_devices.channel_id，见 [DEFAULT_PUSH_CHANNEL_ID]）。
   * 缺省（老客户端）时按 env `OPPO_PUSH_CHANNEL_ID` → 默认常量 依次回退。
   */
  channelId?: string | undefined;
  /** 离线 TTL（秒） */
  ttlSeconds?: number;
}

export interface OppoSendResult {
  ok: boolean;
  /** OPPO 返回码（0 成功；10000 目标失效；11 鉴权过期…） */
  code: number;
  /** 服务端返回的错误描述（成功或本地错误时为 undefined） */
  message?: string | undefined;
  /** code=10000：registration_id 已失效，调用方应从设备表里删掉 */
  invalidToken?: boolean;
}

/** 单条文本按字符数截断（在文案层做，避免把超长内容送到接口被整条拒绝） */
export function clampChars(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * 向一个 registration_id 推送通知栏消息。
 *
 * 重试策略：`code=11`（auth_token 过期）清缓存重试一次；其余一律不重试
 * （重复推送的代价是用户看到两条一样的通知，比漏一条更糟）。
 */
export async function sendUnicast(
  registrationId: string,
  payload: OppoNotificationPayload
): Promise<OppoSendResult> {
  if (!isOppoPushConfigured()) return { ok: false, code: -1, message: '未配置 OPPO 推送' };

  const first = await sendUnicastOnce(registrationId, payload);
  if (first.code !== 11) return first;
  invalidateAuth();
  return sendUnicastOnce(registrationId, payload);
}

async function sendUnicastOnce(
  registrationId: string,
  payload: OppoNotificationPayload
): Promise<OppoSendResult> {
  const token = await getAuthToken();
  if (!token) return { ok: false, code: -1, message: '鉴权不可用' };

  const notification: Record<string, unknown> = {
    title: clampChars(payload.title, MAX_TITLE_CHARS),
    content: clampChars(payload.content, MAX_CONTENT_CHARS),
    // 4 = 打开应用内页（activity），见 OppoNotificationPayload.activityClassName 说明
    click_action_type: 4,
    click_action_activity: payload.activityClassName,
    action_parameters: payload.actionParameters,
    // 离线消息：设备当时不在线时由系统在 TTL 内补投
    off_line: true,
    off_line_ttl: payload.ttlSeconds ?? env.OPPO_PUSH_TTL_SECONDS ?? DEFAULT_TTL_SECONDS,
    // ★ 恒设置（Android 9+ 缺了它设备端静默丢弃，见 DEFAULT_PUSH_CHANNEL_ID 注释）：
    //   设备上报值 → env 覆盖 → 默认常量
    channel_id: payload.channelId ?? env.OPPO_PUSH_CHANNEL_ID ?? DEFAULT_PUSH_CHANNEL_ID,
    // OPPO 桌面数字角标（官方《桌面数字角标使用规范》，ColorOS 16+）：每条推送让
    // 桌面图标角标 +1（用户打开 App 后由系统归零）。badge_class = 角标落在哪个
    // 图标上，取启动 Activity 全类名。⚠️ 只对 OPPO 开通了「桌面数字角标」能力的
    // 应用生效（通讯类目需申请，未上架时通常未开通）—— 未开通时 OPPO 忽略该字段、
    // 保持默认红点，不影响消息本身；若日后日志出现因此被拒的错误码，先删这两行。
    badge_add_num: 1,
    badge_class: LAUNCHER_ACTIVITY,
  };

  const message = {
    // 2 = registration_id（官方"单点推送"定义）
    target_type: 2,
    target_value: registrationId,
    notification,
  };

  try {
    const res = await fetch(`${apiBase()}/server/v1/message/notification/unicast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ auth_token: token, message: JSON.stringify(message) }).toString(),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const json = (await res.json()) as { code?: number; message?: string };
    const code = typeof json.code === 'number' ? json.code : -1;
    if (code === 0) return { ok: true, code };

    // 10000 = registration_id 格式不正确/已失效：常态（卸载、换机），交给调用方清库
    const invalidToken = code === 10000;
    if (code === 11) {
      logger.info({ registrationId: maskToken(registrationId) }, 'OPPO 推送 auth_token 过期，准备重试');
    } else if (!invalidToken) {
      logger.warn(
        { code, message: json.message, registrationId: maskToken(registrationId) },
        'OPPO 推送失败'
      );
    }
    return { ok: false, code, message: json.message, invalidToken };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), registrationId: maskToken(registrationId) },
      'OPPO 推送请求失败（网络/超时）'
    );
    return { ok: false, code: -1, message: '网络错误' };
  }
}

// ------------------------------------------------------------------
// 失效回执
// ------------------------------------------------------------------

/**
 * 拉取系统判定的失效 registration_id 列表（每次最多 500 个，取回后服务端会删除它们，
 * 所以调用方**必须先落库删除、再丢弃**——丢了就再也拿不回来了）。
 *
 * 自定义 API 域名（沙箱/测试）时直接返回空：那是真实生产反馈接口。
 */
export async function fetchInvalidRegistrationIds(): Promise<string[]> {
  if (!isOppoPushConfigured() || isCustomApiBase()) return [];
  const token = await getAuthToken();
  if (!token) return [];

  try {
    const url = `${FEEDBACK_ORIGIN}/server/v1/feedback/fetch_invalid_regidList?auth_token=${encodeURIComponent(token)}`;
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    const json = (await res.json()) as {
      code?: number;
      data?: { registration_ids?: string[] } | null;
    };
    if (json.code !== 0) {
      logger.warn({ code: json.code }, 'OPPO 失效回执拉取失败');
      return [];
    }
    return Array.isArray(json.data?.registration_ids) ? json.data!.registration_ids! : [];
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'OPPO 失效回执请求失败');
    return [];
  }
}

/** 日志里不落全量注册 id（它是设备级标识，脱敏只留头尾） */
export function maskToken(token: string): string {
  if (token.length <= 12) return token;
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}
