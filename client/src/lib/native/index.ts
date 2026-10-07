/**
 * ============================================================
 * 原生能力入口（lib/native）
 * ============================================================
 * 全项目**只从这里**访问原生能力（取代散落各处的 `@capacitor/*`）。
 * 设计原则：
 * 1. 浏览器（无桥）环境下每个 API 都安全降级：能返回值的返回 null/false，
 *    fire-and-forget 的直接静默 —— 调用方原有的 Web 回退路径继续生效；
 * 2. 原生调用失败一律吞掉并打日志，**绝不让"原生能力不可用"变成"页面功能失效"**；
 * 3. 同步读（版本号/返回键裁决）与异步调用（打开查看器/沉浸）分开，
 *    与 Kotlin 侧 `KNativeBridge` 的方法表一一对应。
 * ============================================================
 */

import { call, isNative, on, syncAppInfo } from './bridge';
import type {
  DeeplinkPayload,
  DeviceInfoSnapshot,
  DownloadEvent,
  MediaCommandEvent,
  NativeAppInfo,
  NetworkChangedEvent,
  PipChangedEvent,
} from './types';

export {
  isNative,
  call,
  on,
  prefsGet,
  prefsSet,
  syncAppInfo,
  setBackDecisionHandler,
  notifyWebReady,
  NativeError,
} from './bridge';
export type {
  NativeAppInfo,
  NativeEvent,
  NativeErrorCode,
  NativeViewerRect,
  NativeViewerResult,
  OpenNativeViewerOptions,
  DownloadEvent,
  DeeplinkPayload,
  MediaCommandEvent,
  PipChangedEvent,
  NetworkType,
  DeviceInfoSnapshot,
  NetworkChangedEvent,
} from './types';
export { BRIDGE_VERSION } from './types';

/** App 版本信息（与旧 `App.getInfo()` 对齐：`version` / `build`） */
export interface AppInfo {
  version: string;
  build: number;
  platform: string;
}

/** 读取 App 版本（同步读桥，包在 Promise 里保持调用方写法不变） */
export async function getAppInfo(): Promise<AppInfo | null> {
  const info: NativeAppInfo | null = syncAppInfo();
  if (!info) return null;
  return { version: info.versionName, build: info.versionCode, platform: info.platform };
}

/** fire-and-forget：失败只打日志（原生能力不该让页面报错） */
function fireAndForget(method: string, params?: unknown): void {
  if (!isNative()) return;
  void call(method, params).catch((err) => {
    console.warn(`[native] ${method} 调用失败`, err);
  });
}

/** 最小化到后台（双击返回的场景；勿用"杀进程"语义） */
export function minimizeApp(): void {
  fireAndForget('app.minimize');
}

/** 状态栏图标明暗：light | dark | system（system = 跟随系统） */
export function setStatusBarStyle(mode: 'light' | 'dark' | 'system'): void {
  fireAndForget('statusBar.setStyle', { mode });
}

/** 状态栏底色（非 edge-to-edge 机型/Android 16 之前有效） */
export function setStatusBarBackground(color: string): void {
  fireAndForget('statusBar.setBackground', { color });
}

/**
 * 窗口/根视图背景色：EDGE-TO-EDGE 下状态栏区域透出的就是它，
 * 必须跟随网页主题（浅色 #eef2ee / 深色 #0d0f14），否则状态栏位置会露白或露黑。
 */
export function setWindowBackgroundColor(color: string): void {
  fireAndForget('window.setBackgroundColor', { color });
}

/** 沉浸模式：隐藏/恢复系统栏（网页全屏时由 useFullscreenImmersive 驱动） */
export function setImmersiveMode(enabled: boolean): void {
  fireAndForget('immersive.setEnabled', { enabled });
}

/** 用系统浏览器/系统组件打开外部链接（APK 下载、备案号跳转等） */
export function openExternal(url: string): void {
  fireAndForget('external.open', { url });
}

// ------------------------------------------------------------------
// 二期 W1：下载 / 安装 / 保存相册 / 系统分享
// ------------------------------------------------------------------

/**
 * 交给系统 DownloadManager 下载（后台/杀进程也继续，自带通知栏进度）。
 * 下载完成/失败会经 `onDownload` 事件回来（payload 里带同一个 id）。
 */
export function downloadFile(url: string, fileName?: string, mimeType?: string): Promise<{ id: number }> {
  return call<{ id: number }>('file.download', { url, fileName, mimeType });
}

/**
 * APK 自更新：下载完成后**原生侧自动拉起安装**（不需要网页再调 install）。
 * 未授予"安装未知应用"时会引导到系统设置，用户授权后需再点一次。
 */
export function updateApk(url: string, fileName?: string): Promise<{ id: number }> {
  return call<{ id: number }>('file.updateApk', { url, fileName });
}

/** 安装已下载完成的 APK（一般由 updateApk 自动完成，这里用于手动重试） */
export function installDownloadedApk(id: number): Promise<{ installing: boolean }> {
  return call<{ installing: boolean }>('file.installApk', { id });
}

/** 订阅下载事件；返回退订函数（非原生环境返回空函数） */
export function onDownload(callback: (event: DownloadEvent) => void): () => void {
  return on('download', (payload) => callback(payload as DownloadEvent));
}

/** 保存网络图片到系统相册（native 查看器右下角也有同名按钮） */
export function saveImage(
  url: string,
  options?: { headers?: Record<string, string>; fileName?: string }
): Promise<{ saved: string | null }> {
  // 原生侧要先把原图抓下来（连接 15s + 读取 60s），弱网下可能远超默认 15s；
  // 这里给到 120s，否则会出现"原生还在下载、网页已经判失败"的错位
  return call<{ saved: string | null }>(
    'media.saveImage',
    {
      url,
      headers: options?.headers,
      fileName: options?.fileName,
    },
    { timeoutMs: 120_000 }
  );
}

/** 系统分享（文本/链接） */
export function shareText(text: string, title?: string): Promise<{ shared: boolean }> {
  return call<{ shared: boolean }>('share.text', { text, title });
}

/** 系统分享（图片：原生先抓取到缓存再交给分享面板） */
export function shareImage(
  url: string,
  options?: { headers?: Record<string, string>; text?: string }
): Promise<{ shared: boolean }> {
  // 同 saveImage：原生要先下载图片，给足 120s
  return call<{ shared: boolean }>(
    'share.image',
    {
      url,
      headers: options?.headers,
      text: options?.text,
    },
    { timeoutMs: 120_000 }
  );
}

// ------------------------------------------------------------------
// 二期 W2：本地通知 + 深链
// ------------------------------------------------------------------

export interface LocalNotificationOptions {
  title: string;
  body: string;
  /** 点击后跳转的站内路径（如 `/post/12`） */
  deeplink?: string;
  /** 通知 id（缺省由原生用时间戳）；同 tag 下同 id 会覆盖 */
  id?: number;
  /** 合并键：同一会话的多条通知合成一条 */
  tag?: string;
}

/**
 * 弹一条本地通知（**只在 App 处于后台时用** —— 前台由页面自己提示）。
 * 未授予通知权限时原生返回 `{shown:false}`，不抛错。
 */
export function notify(options: LocalNotificationOptions): Promise<{ shown: boolean }> {
  return call<{ shown: boolean }>('notify.show', options);
}

/** 通知当前状态：是否可弹、是否需要先申请权限（Android 13+） */
export function getNotificationStatus(): Promise<{ enabled: boolean; needPermission: boolean }> {
  return call<{ enabled: boolean; needPermission: boolean }>('notify.status');
}

/** 申请通知权限（Android 13+；已授权时直接返回 granted=true） */
export function requestNotificationPermission(): Promise<{ granted: boolean }> {
  return call<{ granted: boolean }>('notify.requestPermission');
}

/**
 * 订阅深链（通知点击 / 外部链接路由到 App / 「分享到 K」）。
 * 返回退订函数；非原生环境返回空函数。
 */
export function onDeeplink(callback: (payload: DeeplinkPayload) => void): () => void {
  return on('deeplink', (payload) => {
    const data = payload as DeeplinkPayload | null;
    if (data && typeof data.kind === 'string') callback(data);
  });
}

// ------------------------------------------------------------------
// 二期 W3：后台音频 / 画中画 / 生物识别
// ------------------------------------------------------------------

/** 前台服务的两种用途（语音房优先级更高） */
export type PlaybackKind = 'voice' | 'music';

/**
 * 起前台服务保活后台音频。
 * - `voice`：同时声明 mediaPlayback + microphone 类型 —— **Android 14+ 后台麦克风采集
 *   必须由它持有**，否则系统会把语音房的麦克风静音；
 * - `music`：仅 mediaPlayback。
 *
 * 返回的 `requested` 只表示"已请求启动"：真正进入前台是异步的
 * （服务要等 `onStartCommand`），所以**不要**拿它判断是否已保活；
 * 状态变化经 `media.foreground` 事件回报。
 */
export function startBackgroundPlayback(
  kind: PlaybackKind,
  title: string,
  text: string
): Promise<{ requested: boolean }> {
  return call<{ requested: boolean }>('media.startForeground', { kind, title, text });
}

/** 更新常驻通知文案（切歌、房间名变化） */
export function updateBackgroundPlayback(title: string, text: string): Promise<void> {
  return call<void>('media.updateForeground', { title, text });
}

/** 停前台服务（离开语音房/停止播放） */
export function stopBackgroundPlayback(): Promise<void> {
  return call<void>('media.stopForeground');
}

/** 订阅前台服务命令（通知栏"停止"、音频焦点丢失/恢复） */
export function onMediaCommand(callback: (event: MediaCommandEvent) => void): () => void {
  return on('media.command', (payload) => {
    const data = payload as MediaCommandEvent | null;
    if (data && typeof data.action === 'string') callback(data);
  });
}

/** 声明"现在适合画中画"（视频/共享画面在放）；系统在用户按 Home 时据此进小窗 */
export function setPipEnabled(enabled: boolean): Promise<void> {
  return call<void>('pip.setEnabled', { enabled });
}

/** 主动进画中画（WebView 不支持网页版 PiP API，只能走原生） */
export function enterPip(): Promise<{ entered: boolean }> {
  return call<{ entered: boolean }>('pip.enter');
}

/** 订阅画中画状态变化（进/出小窗时网页可精简 UI） */
export function onPipChanged(callback: (event: PipChangedEvent) => void): () => void {
  return on('pip.changed', (payload) => {
    const data = payload as PipChangedEvent | null;
    if (data && typeof data.inPip === 'boolean') callback(data);
  });
}

// ------------------------------------------------------------------
// 二期 W4：系统信息
// ------------------------------------------------------------------

/**
 * 系统信息快照（网络/电量/存储/深色模式/机型）。
 * 只读、不需要任何权限；非原生环境 reject，调用方自行降级。
 */
export function getDeviceInfo(): Promise<DeviceInfoSnapshot> {
  return call<DeviceInfoSnapshot>('device.info');
}

/** 订阅网络变化（原生 ConnectivityManager；比 WebView 的 navigator.onLine 可靠） */
export function onNetworkChanged(callback: (event: NetworkChangedEvent) => void): () => void {
  return on('network.changed', (payload) => {
    const data = payload as NetworkChangedEvent | null;
    if (data && typeof data.type === 'string') callback(data);
  });
}

/**
 * 冷启动首帧耗时（原生侧测量：onCreate → 页面首个内容可见）。
 * 用途是**诊断与发版回归对比**，不做用户可见提示。
 */
export function onFirstPaint(callback: (event: { ms: number }) => void): () => void {
  return on('perf.firstPaint', (payload) => {
    const data = payload as { ms?: number } | null;
    if (data && typeof data.ms === 'number') callback({ ms: data.ms });
  });
}

/**
 * WebView 渲染进程崩溃并**已被原生重建**（进程内已恢复，页面重新加载）。
 * 累计次数落盘，便于发现"偶发崩溃"这类只在长期使用中暴露的问题。
 */
export function onRendererGone(callback: (event: { count: number }) => void): () => void {
  return on('diagnostics.rendererGone', (payload) => {
    const data = payload as { count?: number } | null;
    if (data && typeof data.count === 'number') callback({ count: data.count });
  });
}
