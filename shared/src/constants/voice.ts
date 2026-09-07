/**
 * ============================================================
 * 语音域共享常量（@k/shared）
 * ============================================================
 * 纯数据/纯正则：双端（client/server）各自按需构造自己的类型数组引用，
 * 保证 ICE 兜底配置、控制字符清洗规则只有一份事实来源。
 */

/**
 * 兜底 STUN 服务器地址列表（仅 STUN，无凭据）。
 *
 * 注意：这是"纯数据"，不含客户端 RTCIceServer 或服务端 ICE 条目的对象形状；
 * 两端各自构造自己的数组引用它：
 * - 客户端: [{ urls: [...STUN_SERVER_URLS] }]
 * - 服务端: [{ urls: [...STUN_SERVER_URLS] }]
 * 地址内容与顺序即线上真实下发/兜底内容，改动前需确认两端行为同步。
 */
export const STUN_SERVER_URLS = [
  'stun:stun.qq.com:3478',
  'stun:stun.miwifi.com:3478',
  'stun:stun.l.google.com:19302',
] as const;

/**
 * 控制字符（除 \n 换行外）剔除正则：聊天消息入库/发送前清理，
 * 防协议与显示污染。客户端发送前与服务端入库前各做一次（行为不变）。
 *
 * 全局 flag 与 lastIndex 说明：两端用法都是 String.prototype.replace——
 * replace 会从头扫描整个字符串并在调用结束后把 lastIndex 重置为 0，
 * 因此跨端、跨调用共享同一正则实例是安全的；
 * 若未来改为逐次 exec/match/test 的用法，需自行处理 lastIndex 复位。
 */
export const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** 语音房间人数上限（Mesh P2P 架构下音频路数的合理上限） */
export const VOICE_MAX_ROOM_SIZE = 10;

/** 语音房间文字聊天：单条消息长度上限（字符） */
export const VOICE_CHAT_MAX_LEN = 500;
