/**
 * ============================================================
 * 原生桥：类型定义（lib/native/types）
 * ============================================================
 * 这里是**协议契约**，与 android/app/src/main/java/top/kuangdada/k/bridge/**
 * 的 JSON 结构一一对应。改这里必须同步改 Kotlin 侧（见 docs/android-native-architecture.md）。
 * ============================================================
 */

/** 桥协议版本：原生侧 `KNative.version`，两端不一致时降级为"无原生能力" */
export const BRIDGE_VERSION = 1;

/** 同步读：`KNative.info()` 返回的 JSON */
export interface NativeAppInfo {
  /** 平台标识（当前只有 android） */
  platform: 'android';
  /** 版本名（如 0.1.0） */
  versionName: string;
  /** 版本号（versionCode） */
  versionCode: number;
  /** 包名 */
  packageName: string;
  /** 桥协议版本 */
  bridgeVersion: number;
}

/** 原生图片查看器：`viewer.open` 参数（与旧 Capacitor 插件契约保持一致） */
export interface NativeViewerRect {
  /** 物理像素（CSS px × devicePixelRatio），原生侧直接使用 */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OpenNativeViewerOptions {
  images: string[];
  index: number;
  /** 鉴权图片（/api/...）需要的请求头 */
  headers?: Record<string, string>;
  /** 被点缩略图矩形（物理像素），用于 Hero 入场 */
  rect?: NativeViewerRect;
  /** 每张图各自的缩略图矩形（物理像素，与 images 同序），用于反向 Hero 退场 */
  rects?: (NativeViewerRect | null)[];
}

export interface NativeViewerResult {
  /** 关闭时停留的索引；-1 表示被主动 close */
  index: number;
}

/** 原生 → 网页 的事件名（与 Kotlin 侧 emit 的字面量一一对应） */
export type NativeEvent =
  | 'willClose'
  | 'download'
  | 'deeplink'
  | 'media.command'
  | 'media.foreground'
  | 'pip.changed'
  | 'network.changed'
  | 'perf.firstPaint'
  | 'diagnostics.rendererGone'
  | 'appResume'
  | 'permission';

/** 深链事件（通知点击 / 外部链接 / 「分享到 K」三类来源统一成这一种 payload） */
export interface DeeplinkPayload {
  kind: 'link' | 'text' | 'image';
  /** kind=link：站内路径（含 query），如 `/post/12` */
  path?: string;
  /** kind=link：原始 URL（站内链接时用于展示/日志） */
  url?: string;
  /** kind=text：「分享到 K」传来的文本（可能是链接，也可能是任意文字） */
  text?: string;
  /** kind=image：分享进来的图片 content:// 地址 */
  uri?: string;
}

/** 下载事件（原生 DownloadManager 广播转发，见 feature/download/DownloadController.kt） */
export interface DownloadEvent {
  /** DownloadManager 的下载 id（与 updateApk/downloadFile 返回的 id 对应） */
  id: number;
  status: 'downloading' | 'completed' | 'failed' | 'pending' | 'unknown';
  /** 已下载文件的 content:// 地址（完成时才有） */
  uri: string | null;
  fileName: string | null;
}

/** 原生调用失败的错误码 */
export type NativeErrorCode =
  'ERR_NO_BRIDGE' | 'ERR_TIMEOUT' | 'ERR_INVOKE' | 'ERR_UNSUPPORTED' | 'ERR_FAILED' | string;

/** 前台播放服务（后台音频保活）通知的"停止"按钮 / 音频焦点变化 → 网页据此收尾 */
export interface MediaCommandEvent {
  action: 'stop' | 'pause' | 'resume' | 'duck' | 'audioFocusLost';
}

/** 画中画状态变化（系统小窗） */
export interface PipChangedEvent {
  inPip: boolean;
}

/** 网络类型（原生 ConnectivityManager 的判定） */
export type NetworkType = 'wifi' | 'cellular' | 'ethernet' | 'vpn' | 'none';

/** 系统信息快照（`device.info`） */
export interface DeviceInfoSnapshot {
  network: NetworkType;
  /** network !== 'none'；WebView 的 navigator.onLine 在部分机型恒为 true，不可信 */
  online: boolean;
  /** 0–100；读不到为 -1 */
  batteryLevel: number;
  batteryCharging: boolean;
  storageFreeBytes: number;
  storageTotalBytes: number;
  darkMode: boolean;
  locale: string;
  sdkInt: number;
  model: string;
  /** 三期诊断：本机累计的 WebView 渲染进程崩溃次数（跨启动累计） */
  rendererCrashes: number;
  /** 三期诊断：上次冷启动首帧耗时（ms；-1 = 还没记录过） */
  lastFirstPaintMs: number;
  /** 三期诊断：上次进程退出原因（如 REASON_LOW_MEMORY@1699…；null = 读不到） */
  lastExitReason: string | null;
}

/** 网络变化事件 */
export interface NetworkChangedEvent {
  type: NetworkType;
}
