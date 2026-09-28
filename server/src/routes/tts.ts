/**
 * ============================================================
 * 云端朗读路由 (/api/tts)
 * ============================================================
 * 语音房间文字聊天的「朗读」音色代理：浏览器 → 本服务 → StepFun TTS。
 * 前端只认共享包里的音色 key（`dengziqi` 等），**厂商音色 ID 与 API Key
 * 一律不出服务端**（见 shared/src/constants/tts.ts 的说明）。
 *
 * API 端点:
 * - POST /api/tts - 合成一段文本，直接返回 audio/mpeg（不是 JSON）
 *   请求体: { text: string, voice?: <TtsCloudVoiceKey> }
 *   响应:  200 audio/mpeg | 400 参数错 | 429 过于频繁 | 502 上游失败 | 503 未配置密钥
 *
 * 认证策略（与语音房间保持一致，游客也能用）:
 * - optionalAuth：带了有效 token 就按用户维度限流（额度更宽），
 *   没带/无效则按 IP 维度限流（额度收紧）—— 这是「Key 不被盗刷」的第一道闸：
 *   接口本身必须允许未登录访客（房间支持游客），所以限流就是唯一的成本闸门。
 *
 * 成本量级（StepFun 5.8 元/万字符）：单次 1000 字符 ≈ 0.58 元。
 * 限流阈值按「正常聊天朗读远用不满、恶意刷取又被压住」取：
 * 登录 30 次/分/用户、游客 6 次/分/IP（叠加上游 /api 全局 120 次/分钟写限流）。
 * ============================================================
 */

import { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { env } from '../config';
import { optionalAuth } from '../middleware/auth';
import { logger } from '../lib/logger';
import { TTS_CLOUD_VOICES, TTS_MAX_CHARS, type TtsCloudVoiceKey } from '@k/shared';

const router = Router();

/** StepFun 语音合成端点与固定模型（StepAudio 2.5 TTS） */
const TTS_ENDPOINT = 'https://api.stepfun.com/step_plan/v1/audio/speech';
const TTS_MODEL = 'stepaudio-2.5-tts';

/**
 * 音色 key → 厂商音色 ID（**只在服务端存在**）。
 *
 * 类型写成 Record<TtsCloudVoiceKey, string>：共享包新增音色却忘了在这里补映射时，
 * 编译期直接报错（这是两端清单不漂移的保证）。
 * 音色换绑用环境变量覆盖（TTS_VOICE_DENGZIQI），不必改代码。
 */
const CLOUD_VOICE_IDS: Record<TtsCloudVoiceKey, string> = {
  dengziqi: env.TTS_VOICE_DENGZIQI ?? 'voice-tone-UfTMTasMym',
};

/** 未指定音色时用清单里第一个（也是唯一一个）云端音色 */
const DEFAULT_VOICE_KEY: TtsCloudVoiceKey = TTS_CLOUD_VOICES[0].key;

/** 上游合成超时：非流式首段通常 2~5s，长文本可能更久；30s 兜底防连接悬挂 */
const UPSTREAM_TIMEOUT_MS = 30_000;

/**
 * 朗读专属限流（比全局写限流更严，因为每次调用都要真金白银调上游）。
 * - 已登录（optionalAuth 注入 req.user）：按用户计，30 次/分钟
 * - 游客：按 IP 计，6 次/分钟（IPv6 走 ipKeyGenerator 归一到 /56 网段，
 *   否则一个 IPv6 用户随手换地址就能绕过——express-rate-limit v8 的建议用法）
 */
const speakLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: (req) => (req.user ? 30 : 6),
  keyGenerator: (req) => (req.user ? `u:${req.user.id}` : ipKeyGenerator(req.ip ?? '')),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '朗读太过频繁，请稍等一下再试' },
});

/** 本路由的鉴权解析必须在限流之前：限流需要按「用户 or IP」分流 */
router.use(optionalAuth);

router.post('/', speakLimiter, async (req, res) => {
  // ---- 1. 服务端未配置密钥：明确告知（前端据此提示"云端音色未开通"）----
  if (!env.STEP_API_KEY) {
    res.status(503).json({ error: '云端朗读未配置（服务端缺少 STEP_API_KEY）' });
    return;
  }

  // ---- 2. 入参校验（在花掉上游额度之前全部挡掉）----
  const body = (req.body ?? {}) as { text?: unknown; voice?: unknown };
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) {
    res.status(400).json({ error: 'text is required' });
    return;
  }
  if (text.length > TTS_MAX_CHARS) {
    res.status(400).json({ error: `单次最多 ${TTS_MAX_CHARS} 字符，请前端先分段` });
    return;
  }
  // 音色 key 白名单：不在清单里的一律落回默认，避免前端塞任意字符串去试音色
  const asked = typeof body.voice === 'string' ? body.voice.trim() : '';
  const voiceKey = TTS_CLOUD_VOICES.some((v) => v.key === asked)
    ? (asked as TtsCloudVoiceKey)
    : DEFAULT_VOICE_KEY;

  // ---- 3. 转发上游 ----
  // ★ 必须把「客户端断开」传播到上游。
  //   朗读是可以被随时打断的操作（换音色、点下一条、退出房间，客户端都会取消在途请求），
  //   如果这里不 abort，那次合成就**继续跑到结束**：既白花钱，又会**一直占着上游的并发槽**。
  //   StepFun 的账号级并发上限只有 5 —— 几个这样的"僵尸合成"就能把额度占满，
  //   之后所有人的朗读都变成 429。
  //   实证（2026-09-28）：用户连续操作 11 秒发出 20+ 次请求，服务端日志里
  //   `msg:"request aborted"`（客户端取消）与上游 `concurrency reached, current: 6, limit: 5`
  //   同时出现，客户端看到的是「云端朗读暂时不可用」。
  const clientGone = new AbortController();
  res.on('close', () => {
    // writableEnded=false ⇒ 响应没正常写完 ⇒ 是客户端主动断开（而不是我们把包回完了）
    if (!res.writableEnded) clientGone.abort();
  });

  try {
    const upstream = await fetch(TTS_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.STEP_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: TTS_MODEL,
        voice: CLOUD_VOICE_IDS[voiceKey],
        input: text,
        response_format: 'mp3',
      }),
      signal: AbortSignal.any([AbortSignal.timeout(UPSTREAM_TIMEOUT_MS), clientGone.signal]),
    });

    if (!upstream.ok) {
      // 上游报文可能含密钥上下文/内部细节，只截断记录到服务端日志，对外给简短原因
      const detail = await upstream.text();
      logger.error({ status: upstream.status, voiceKey, detail: detail.slice(0, 300) }, 'TTS 上游返回错误');
      // 401/403 是「Key 失效」这类部署问题，对外统一 502，避免前端把它当业务错误重试
      const status = upstream.status === 429 ? 429 : 502;
      res.status(status).json({
        error:
          upstream.status === 401 || upstream.status === 403
            ? '云端朗读密钥无效，请联系管理员'
            : upstream.status === 429
              ? // 上游 429 = 并发/配额打满。原先这里统一说"暂时不可用"，用户既看不懂
                // 也不知道该做什么；限流类文案必须让人能自己调整行为（等一下再试）。
                '朗读得有点快，稍等几秒再试'
              : '云端朗读暂时不可用',
      });
      return;
    }

    const audio = Buffer.from(await upstream.arrayBuffer());
    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Length', String(audio.byteLength));
    // 同一段文本重复请求无收益，且服务端不缓存音频，直接给浏览器 no-store
    res.set('Cache-Control', 'no-store');
    res.send(audio);
  } catch (e) {
    // 客户端断开触发的取消不是"上游故障"：不记 error、也不必回包（连接已经断了）
    if (clientGone.signal.aborted) {
      // 用 info 而不是 debug：这条记录同时是「取消已传播到上游」的**证据** ——
      // 它意味着"用户已经不要这段了，我们没有继续花钱合成、也没让它占着并发槽"。
      // 生产环境要看得出这件事发生过（诊断 429 时，就是靠它与上游报错对照）。
      logger.info({ voiceKey }, '客户端已断开，已中止上游合成');
      return;
    }
    // 超时（TimeoutError）与网络故障都归到这里
    logger.error({ err: e, voiceKey }, 'TTS 上游请求失败');
    if (!res.headersSent) res.status(502).json({ error: '云端朗读暂时不可用' });
  }
});

export default router;
