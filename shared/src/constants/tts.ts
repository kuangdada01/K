/**
 * ============================================================
 * 朗读（TTS）共享常量（@k/shared）
 * ============================================================
 * 前端音色下拉框与服务端音色白名单的**唯一事实来源**，避免两端清单漂移。
 *
 * 安全边界（重要）：
 * - 这里只放「音色标识 key + 显示名」，**不放厂商真实音色 ID**，也不放任何 Key。
 * - key → StepFun voice id 的映射、以及 API Key，只存在服务端
 *   （server/src/routes/tts.ts + .env 的 STEP_API_KEY），前端拿不到也不该拿到。
 * - 新增云端音色：在此数组加一项，并在 tts.ts 的 CLOUD_VOICE_IDS 补映射——
 *   后者是 `Record<TtsCloudVoiceKey, string>`，漏补会被 TypeScript 直接拦下。
 */

/** 系统语音（浏览器自带 speechSynthesis）的固定 key：零成本、无需联网 */
export const TTS_SYSTEM_VOICE_KEY = 'system';

/**
 * 云端音色清单（下拉框顺序即数组顺序）。
 * 走服务端代理 /api/tts，Key 不出服务端。
 */
export const TTS_CLOUD_VOICES = [{ key: 'dengziqi', label: '邓紫棋' }] as const;

/** 云端音色 key 的联合类型（服务端映射表用它约束完整性） */
export type TtsCloudVoiceKey = (typeof TTS_CLOUD_VOICES)[number]['key'];

/**
 * 单次请求文本上限（字符）。
 *
 * 服务端硬校验：StepFun 合成接口单次上限 1000 字符，超了会 400。
 * 前端长文必须按 TTS_CHUNK_CHARS 先分段（useChatTTS 已内置）。
 */
export const TTS_MAX_CHARS = 1000;

/** 前端分段上限：低于服务端上限，给分段拼接处的标点留余量 */
export const TTS_CHUNK_CHARS = 900;
