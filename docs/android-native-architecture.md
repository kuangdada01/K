# 原生安卓宿主架构与桥协议（android/）

> 配套文档：`docs/android-native-refactor.md`（重构方案与决策依据）、`docs/native-image-viewer.md`（看图器行为规格与真机清单）。
> 本文件是**开发/排查手册**：桥有哪些方法、数据存在哪、出问题先看哪里。

---

## 1. 三层结构

```
React Web UI（client/dist → android/app/src/main/assets/web/**）
        ▲ │  window.KNative（原生注入）        window.__KNative（网页安装）
        ▼ │
Kotlin 原生宿主（top.kuangdada.k）
  ├── MainActivity        窗口/系统栏/沉浸/高刷/缓存/返回键/ActivityResult 注册
  ├── web/AssetServer     WebViewAssetLoader：assets/web → https://appassets.androidplatform.net（含 Range/206）
  ├── web/WebViewSetup    WebSettings（JS/DOM storage/多窗口/关缩放/禁 file 访问）
  ├── web/KWebViewClient  资源拦截、外链跳系统浏览器、渲染进程重建
  ├── web/KWebChromeClient 文件选择/拍照、麦克风摄像头授权、HTML5 全屏、window.open
  ├── bridge/KNativeBridge JS 入口：同步读 + 异步调用 + 事件
  └── feature/viewer      原生图片查看器（Hero 双向转场、缩放手势、下拉关闭）+ ViewerEvents
        │
        ▼  HTTPS / WSS   https://www.kuangdada.top
```

页面来源固定为 **`https://appassets.androidplatform.net`**（WebViewAssetLoader 官方资源域，HTTPS = 安全上下文，
`getUserMedia`/剪贴板等 API 与线上 Web 行为一致）。URL 空间与 Web 构建完全一致：
`/` → index.html、`/assets/*`（Vite 产物）、`/music/*`、`/favicon.svg`、`/theme-init.js`。

---

## 2. 桥协议契约

### 2.1 网页 → 原生：同步读（`@JavascriptInterface`，在 WebView 的 Java 桥线程直接返回）

| 方法                   | 签名                      | 说明                                                                              |
| ---------------------- | ------------------------- | --------------------------------------------------------------------------------- |
| `version()`            | `() => number`            | 桥协议版本（当前 1）。**Java 不能暴露字段**，故是方法                             |
| `info()`               | `() => string`            | App 信息 JSON：`{platform, versionName, versionCode, packageName, bridgeVersion}` |
| `prefsGet(key)`        | `(key) => string \| null` | 原生偏好（SharedPreferences `k_native`）                                          |
| `prefsSet(key, value)` | `(key, value) => void`    | 同上；键名由网页侧统一加 `k_native_` 前缀                                         |
| `webReady()`           | `() => void`              | 网页已安装 `__KNative`、订阅已就绪 —— 原生收到后才补发冷启动深链（见 2.3）        |

> 同步方法只做纯数据读取，**绝不碰 UI**（桥线程不是主线程）。

### 2.2 网页 → 原生：异步调用 `invoke(callId, method, paramsJson)`

原生在**主线程**执行，完成后回调 `window.__KNative.resolve(callId, ok, payloadJson)`；
网页侧默认 15s 超时（`ERR_TIMEOUT`），可用 `KNative.cancel(callId)` 取消。

**超时可逐调用覆盖**：`call(method, params, { timeoutMs })`，`timeoutMs: 0` = **永不超时**。有些方法的
"完成"取决于**用户行为**而不是原生处理速度，统一 15s 会把它们误判为失败：

| 方法                                                 | timeoutMs | 不覆盖会怎样                                                                 |
| ---------------------------------------------------- | --------- | ---------------------------------------------------------------------------- |
| `viewer.open`                                        | `0`       | 看图超过 15s → 网页以为原生失败 → **叠加一层 Web 全屏图**（关掉后露出一层）  |
| `biometric.authenticate`                             | `0`       | 等人按指纹超过 15s → 被判"原生不可用" → **放行私密内容**（最严重的一种误判） |
| `media.saveImage` / `share.image`（抓取 + 写盘大图） | `120_000` | 大图抓取慢 → 报"超时失败"，用户以为没保存                                    |
| 其余（状态栏、通知、下载入队…）                      | 默认 15s  | 正常                                                                         |

超时只 reject 网页侧的 Promise，**不改变原生行为**：原生的迟到结果会被丢弃（`pending` 已删除）。
因此需要"迟到结果也要落地"的场景必须用 `timeoutMs: 0`，而不是靠默认超时兜底。

| method                      | params                                               | result                      | 说明                                                                       |
| --------------------------- | ---------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------- |
| `app.minimize`              | —                                                    | —                           | `moveTaskToBack`（双击返回的语义；**不是**杀进程）                         |
| `app.reload`                | —                                                    | —                           | 重新加载本地页面                                                           |
| `statusBar.setStyle`        | `{mode: 'light'\|'dark'\|'system'}`                  | —                           | 状态栏图标明暗（system 由原生读系统 uiMode）                               |
| `statusBar.setBackground`   | `{color: '#rrggbb'}`                                 | —                           | edge-to-edge 下与窗口背景同源                                              |
| `window.setBackgroundColor` | `{color: '#rrggbb'}`                                 | —                           | 状态栏区域透出的那一层，必须跟随主题                                       |
| `immersive.setEnabled`      | `{enabled: boolean}`                                 | —                           | 隐藏/恢复系统栏（网页全屏时由 JS 成功回调驱动）                            |
| `external.open`             | `{url}`                                              | `{opened: boolean}`         | 系统浏览器/系统组件打开                                                    |
| `viewer.open`               | `{images: string[], index, headers?, rect?, rects?}` | `{index: number}`           | 原生看图；矩形为**物理像素**（CSS px × DPR）                               |
| `viewer.close`              | —                                                    | `{index: -1}`               | 关闭查看器并让在途 `viewer.open` 以 -1 结算                                |
| `file.download`             | `{url, fileName?, mimeType?}`                        | `{id}`                      | 交系统 `DownloadManager` 下载（后台/杀进程继续、通知栏进度）               |
| `file.updateApk`            | `{url, fileName?}`                                   | `{id}`                      | APK 自更新：**下载完成自动拉起安装**；未授权"安装未知应用"时引导到系统设置 |
| `file.installApk`           | `{id}`                                               | `{installing}`              | 手动重试安装已下载的 APK                                                   |
| `media.saveImage`           | `{url, headers?, fileName?}`                         | `{saved: string \| null}`   | 保存到系统相册（`Pictures/K`）；API<29 需存储权限，缺失时先申请            |
| `share.text`                | `{text, title?}`                                     | `{shared}`                  | 系统分享面板（文本/链接）                                                  |
| `share.image`               | `{url, headers?, text?}`                             | `{shared}`                  | 抓取到缓存 → FileProvider → 分享面板                                       |
| `notify.show`               | `{title, body, deeplink?, id?, tag?}`                | `{shown: boolean}`          | 本地通知（**仅 App 在后台时用**）；无权限时 `shown=false` 不抛错           |
| `notify.status`             | —                                                    | `{enabled, needPermission}` | 通知能否弹 / 是否需先申请（Android 13+）                                   |
| `notify.requestPermission`  | —                                                    | `{granted}`                 | 申请通知权限（已授权时直接返回 true）                                      |

未实现的方法返回 `{code:'ERR_UNSUPPORTED'}`；网页侧一律降级，不抛给业务代码。

### 2.3 原生 → 网页：事件

网页侧由 `client/src/lib/native/bridge.ts` 安装 `window.__KNative`：

| 事件                       | payload                            | 触发时机                                                                                                                                                              |
| -------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `willClose`                | `{index}`                          | **查看器退场飞行动画开始时**（早于 `viewer.open` resolve）——网页据此先把轮播对齐到返回的那一张                                                                        |
| `download`                 | `{id, status, uri, fileName}`      | 下载完成/失败（`DownloadManager` 广播转发）；`status` ∈ `completed`/`failed`/`downloading`/`pending`/`unknown`                                                        |
| `deeplink`                 | `{kind, path?, url?, text?, uri?}` | 三类来源统一投递：`link` = 站内链接被系统路由到 App / 点击本地通知；`text` = 「分享到 K」的文本；`image` = 分享进来的图片。**页面未就绪时原生会缓存，首帧可见后补发** |
| `media.command`            | `{action}`                         | 前台服务/音频焦点转来的命令：`stop`（通知栏「停止」）、`pause`/`resume`（音频焦点丢失/恢复）、`audioFocusLost`/`duck`                                                 |
| `media.foreground`         | `{kind, active}`                   | 前台服务启停确认（`kind` ∈ `voice`/`music`）——网页据此知道自己那条保活请求真的落地了                                                                                  |
| `pip.changed`              | `{active}`                         | 进入/退出系统画中画，网页据此精简 UI                                                                                                                                  |
| `network.changed`          | `{online, type, metered}`          | `ConnectivityManager` 默认网络回调（`navigator.onLine` 在部分机型恒为 true，不可依赖）                                                                                |
| `perf.firstPaint`          | `{ms}`                             | 首个内容可见（`onPageCommitVisible`）——发版后可对比"是不是变慢了"                                                                                                     |
| `diagnostics.rendererGone` | `{count, reason}`                  | 渲染进程崩溃并重建（`count` 为跨启动累计）                                                                                                                            |

`emit` 同时派发 DOM 事件 `knative:<event>`（`CustomEvent`，`detail` 为 payload），
方便非 React 代码监听。`appResume` / `permission` 为后续波次预留。

**冷启动深链为什么必须握手**：原生在"首个内容可见"补发缓存的事件，而那一刻 JS bundle 可能还没执行完、
React 订阅者更没注册 —— 事件发出去没人接，用户看到的就是"点了通知 App 打开了但没跳转"。
所以补发时机改为**网页主动调 `KNative.webReady()` 之后**（`notifyWebReady()`，在 `lib/native` 里自动调用），
且 `lastDeeplink` 保留到真正被消费为止。

### 2.4 返回键：原生问、网页答

原生 `OnBackPressedCallback` → `evaluateJavascript("window.__KNative.onBackPressed()")`，
读**返回值**作为裁决（网页仍是唯一决策者：模态框 → 最深 `[data-back]` → 主 Tab 双击最小化）：

| 返回值       | 原生动作                 |
| ------------ | ------------------------ |
| `'handled'`  | 什么都不做（网页已处理） |
| `'minimize'` | `moveTaskToBack(true)`   |
| `'exit'`     | `finish()`               |

桥未就绪/页面异常（300ms 无响应）→ **最小化**而不是杀进程。

### 2.5 数据真相源（禁止双写）

| 数据                                                                             | 归属    | 存储                                                     |
| -------------------------------------------------------------------------------- | ------- | -------------------------------------------------------- |
| `k_token`（登录态）、`theme`、`k_skip_update_version`、`k_viewer_hero`、房主令牌 | **Web** | `localStorage`                                           |
| `last_version_code`（升级清缓存判定）                                            | 原生    | `SharedPreferences("k_app")`                             |
| 其它原生侧键值                                                                   | 原生    | `SharedPreferences("k_native")`（键名 `k_native_` 前缀） |

原生需要凭证时由网页显式传参（`viewer.open.headers`，见 `authHeadersFor()`）——**JWT 不落原生盘**。

---

## 3. 能力矩阵（当前实现）

| 能力                     | 实现位置                                                    | 备注                                                                                                                                                                          |
| ------------------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 资源托管 + Range/206     | `web/AssetServer.kt`                                        | `/assets/*` 长缓存，其余 `no-store`；压缩资源 Range 退化为整体返回                                                                                                            |
| WebSettings              | `web/WebViewSetup.kt`                                       | JS、DOM storage、多窗口、关缩放、禁 file/content 访问、禁混合内容                                                                                                             |
| 外链跳转                 | `web/KWebViewClient.kt`                                     | 非资源域一律系统浏览器                                                                                                                                                        |
| 渲染进程崩溃恢复         | `web/KWebViewClient.kt`                                     | `onRenderProcessGone` → 宿主重建 WebView（登录态在 localStorage，不丢）                                                                                                       |
| 文件选择/拍照            | `web/KWebChromeClient.kt` + `feature/media/CaptureFiles.kt` | Photo Picker（API 33+）/ `ACTION_GET_CONTENT`，多 MIME 用 `EXTRA_MIME_TYPES`；拍照写 FileProvider 缓存                                                                        |
| 麦克风/摄像头授权        | `web/KWebChromeClient.kt`                                   | 先申请 Android 运行时权限（RECORD_AUDIO/CAMERA），再 grant Web 权限                                                                                                           |
| HTML5 全屏               | `web/KWebChromeClient.kt` + 宿主 custom view 容器           | 页面 `requestFullscreen` 走 custom view 路径                                                                                                                                  |
| `window.open`            | `web/KWebChromeClient.kt`                                   | 探针 WebView 读出真实 URL：站外→系统浏览器，站内→当前 WebView                                                                                                                 |
| 高刷新率                 | `MainActivity.applyHighRefreshRate()`                       | `preferredDisplayModeId` / `preferredRefreshRate` / API35 触摸拉满                                                                                                            |
| 状态栏 / 沉浸 / 窗口背景 | `MainActivity`                                              | hide/show 对称延迟兜底（旧实现真机结论）                                                                                                                                      |
| 升级清 WebView 缓存      | `MainActivity.clearCacheOnUpgrade()`                        | 版本号变化时清一次                                                                                                                                                            |
| 原生看图                 | `feature/viewer/*`                                          | 行为规格见 `docs/native-image-viewer.md`；右下角新增「保存到相册」                                                                                                            |
| 下载与安装 APK（W1）     | `feature/download/DownloadController.kt`                    | `DownloadManager`（通知栏进度、后台继续）+ 下载完自动安装；未授权时引导系统设置                                                                                               |
| 保存到相册（W1）         | `feature/media/MediaStoreSaver.kt`                          | API 29+ 走 MediaStore（`Pictures/K`，无需权限）；24–28 走公共目录 + MediaScanner；带鉴权头抓原图                                                                              |
| 系统分享（W1）           | `feature/share/ShareController.kt`                          | 文本/链接直接 `ACTION_SEND`；图片先抓取到缓存再经 FileProvider 分享                                                                                                           |
| 本地通知（W2）           | `feature/notify/NotificationController.kt`                  | Android 13+ 运行时权限；渠道 `k_default`；点击带 `k_deeplink` 回宿主 → 转成 `deeplink` 事件给网页                                                                             |
| 深链与分享入口（W2）     | `MainActivity.payloadFromIntent()` + Manifest intent-filter | `ACTION_VIEW`（站内 https 链接）/ `ACTION_SEND`（文本、图片）/ 通知点击 → 统一成 `deeplink` 事件；页面未就绪时缓存、首帧后补发                                                |
| 后台音频保活（W3）       | `feature/media/PlaybackService.kt`                          | 前台服务（`mediaPlayback\|microphone`）：**Android 14+ 后台麦克风采集必须由它持有**，否则语音房被系统静音；音频焦点丢失/恢复、通知栏"停止"都转成 `media.command` 事件交给网页 |
| 画中画（W3）             | `MainActivity.enterPip()` + `onUserLeaveHint()`             | WebView 不支持网页版 PiP API；网页用 `pip.setEnabled` 声明时机，按 Home 自动进小窗，进/出转 `pip.changed` 事件                                                                |
| 生物识别（W3）           | `feature/security/BiometricGate.kt`                         | 私密文件夹解锁入口；生物识别 + 设备凭据兜底；**解锁状态由网页持有**，原生不缓存票据                                                                                           |
| 选图压缩（W4）           | `feature/media/ImageCompressor.kt`                          | 文件选择回调**返回给网页之前**压一道：长边 >2560 或 >1.5MB 才压、采样解码 + EXIF 方向烘焙、GIF 跳过；失败一律回退原图                                                         |
| 系统信息（W4）           | `feature/system/DeviceInfo.kt`                              | 网络（原生 `ConnectivityManager`，比 `navigator.onLine` 可靠）/电量/存储/深色模式/机型；网络变化 → `network.changed` 事件                                                     |
| 启动图                   | `core-splashscreen` + `MainActivity`                        | 保持到首个页面可见（`onPageCommitVisible`），8s 兜底                                                                                                                          |

`client/src/lib/native/` 是网页侧唯一入口：`isNative` / `getAppInfo` / `minimizeApp` /
`setStatusBarStyle` / `setStatusBarBackground` / `setWindowBackgroundColor` / `setImmersiveMode` /
`openExternal` / `downloadFile` / `updateApk` / `installDownloadedApk` / `onDownload` /
`saveImage` / `shareText` / `shareImage` / `notify` / `getNotificationStatus` /
`requestNotificationPermission` / `onDeeplink` / `startBackgroundPlayback` /
`updateBackgroundPlayback` / `stopBackgroundPlayback` / `onMediaCommand` / `setPipEnabled` /
`enterPip` / `onPipChanged` / `getBiometricStatus` / `authenticateBiometric` /
`getDeviceInfo` / `onNetworkChanged` /
`call` / `on` / `setBackDecisionHandler` / `prefsGet` / `prefsSet`。
**浏览器环境下全部安全降级**（`isNative()` 为 false、调用 reject、订阅返回空退订），
调用方原有的 Web 回退路径继续生效（例如更新弹窗在非原生或入队失败时回退为浏览器下载）。

上层接线点（`client/src/hooks/`；通知与深链的规则抽在 `client/src/lib/notifications.ts` 并有单测）：

- `useNativeNotifications`：SSE 事件（私信/评论通知/公告）→ **仅 App 在后台时**弹本地通知；只提醒"别人发给我"的私信（自己其他端的回声不弹）；通知权限首次进入 5s 后请求一次，拒绝后不再打扰。
- `useNativeDeeplink`：`link` 直接路由、`text` 是本站链接则路由否则复制并提示、`image` 提示后续支持。
- `useNativeForeground`：语音房/音乐 → **一个**前台服务（语音房优先），并处理 `media.command`（通知栏"停止"→ 退房/暂停；音频焦点丢失 → 暂停且标记"是系统停的"，焦点回来才恢复）。

---

## 4. 常见故障排查

| 现象                      | 先查什么                                                                                                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App 内白屏                | logcat 过滤 `KWebView`/`KChrome`；`npm run android:sync` 是否跑过（`assets/web/index.html` 是否存在）；JS 的 MIME 必须是 `text/javascript`（ES module 严格校验）      |
| 所有请求报网络错误 / 403  | 服务器 `.env` 的 `ALLOWED_ORIGINS` 是否含 `https://appassets.androidplatform.net`；预检头是否覆盖 `X-Voice-Owner-Token`/`Cache-Control`（`server/test/cors.test.ts`） |
| 语音房点麦克风没反应      | Android 运行时权限（RECORD_AUDIO）是否弹过；`KWebChromeClient.onPermissionRequest` 是否 grant                                                                         |
| 全屏后状态栏变白/变黑     | 页面是否用 `env(safe-area-inset-*)` 而非写死高度；沉浸必须由 `requestFullscreen().then` 主动调 `setImmersiveMode(true)`，**不要**用 `document.fullscreenElement` 判断 |
| 音乐进度条不走 / 不能拖动 | 该资源是否落在资源域且未被 aapt 压缩（压缩资源无 `openFd` → 无 206）                                                                                                  |
| 看图 Hero 位置不对        | `rect`/`rects` 是否为**物理像素**；原生对离谱矩形会静默丢弃（退化为淡入）                                                                                             |
| 返回键没反应              | 桥是否注入（`isNative()`）；未注入时 300ms 后最小化                                                                                                                   |
| 更新弹窗不弹              | `.env` 的 `APP_VERSION` 是否**高于**已安装 versionName                                                                                                                |
| 升级后仍是旧页面          | `versionCode` 是否递增（清缓存只在版本变化时执行）；`index.html` 已设 `no-store`                                                                                      |
| 内嵌音乐白占体积          | `npm run android:sync -- --no-bundled-music`（原生端音乐经 `resolveMediaUrl` 指向服务器）                                                                             |

---

## 5. 安全与观测（三期）

### 5.1 安全默认值（`web/WebViewSetup.kt` + `MainActivity.enforceJsInterfaceForUrl`）

| 项                                                                 | 取值                                                  | 理由                                                                                                                             |
| ------------------------------------------------------------------ | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `allowFileAccess`                                                  | `false`                                               | 页面全部来自 APK 内资源域，不需要读写本地文件                                                                                    |
| `allowContentAccess`                                               | **`true`**（刻意例外）                                | 文件选择器/拍照/压缩回传的是 `content://` —— 关掉它等于"选不了图"。内容提供器访问仍受系统权限与 SAF 约束，页面本身拿不到任意路径 |
| `allowFileAccessFromFileURLs` / `allowUniversalAccessFromFileURLs` | `false`                                               | 老 API 上的同类风险，显式关闭                                                                                                    |
| `mixedContentMode`                                                 | `NEVER_ALLOW`                                         | 页面是 https 资源域，接口走 https/wss，没有任何混合内容需求                                                                      |
| `SafeBrowsingEnabled`                                              | `true`                                                | 显式声明，避免被 ROM 默认值影响                                                                                                  |
| `SaveFormData`                                                     | `false`                                               | 表单/密码不进 WebView 自动填充库（登录态由 `localStorage` 的 token 承担）                                                        |
| `GeolocationEnabled`                                               | `false`                                               | 项目没有任何 `navigator.geolocation` 调用                                                                                        |
| **JS 桥注入**                                                      | 仅在 `https://appassets.androidplatform.net` 页面注入 | 每次导航开始时按来源复核：非资源域立即 `removeJavascriptInterface`（外部链接本来就交系统浏览器，这是纵深防御）                   |
| WebView 远程调试                                                   | 仅 debug 包                                           | `WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)`                                                                      |
| 明文流量                                                           | 禁（`network_security_config`）                       | 页面与接口全 https/wss                                                                                                           |

### 5.2 观测（`feature/diagnostics/Diagnostics.kt`）

| 指标             | 落点                                                         | 用途                                                                     |
| ---------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| 上次进程退出原因 | `ApplicationExitInfo`（API 30+）→ 日志 + `SharedPreferences` | 「App 在后台被清掉」终于有直接证据（`REASON_LOW_MEMORY`/`REASON_ANR`/…） |
| 渲染进程崩溃次数 | 跨启动累计在 `SharedPreferences`                             | 偶发崩溃只有长期计数能暴露趋势；崩溃后 WebView 自动重建                  |
| 首帧耗时         | `onCreate` → 首个内容可见，落盘并推 `perf.firstPaint` 事件   | 发版后直接对比，而不是凭感觉说"好像变慢了"                               |

三者都能通过 `device.info`（`rendererCrashes` / `lastFirstPaintMs` / `lastExitReason`）读到，
网页侧在 `useNativeDeviceStatus` 里打一条 console 现场，排查时不必再装工具。

### 5.3 并发与生命周期（对抗式复核的落地）

移动端的坑多半不在"功能对不对"，而在**同一时刻来两件事**和**中途被杀**。这几处都按"单槽位 → 队列"和
"退出必须清理"写：

| 场景                             | 处理                                                                   | 不这样做会怎样                                    |
| -------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------- |
| 连续申请权限（麦克风/相机/通知） | `ArrayDeque` 排队，逐个结算，原生回调只认**当前**那一个                | 第二个请求把第一个的回调顶掉 → 网页永远等不到结果 |
| 系统弹窗里部分授权               | 按资源分别记账（`Map<String, Boolean>`），grant 只覆盖真实允许的资源   | "只允许相机"被当成"录音也允许" → 语音房静默不出声 |
| 文件选择器连点/取消再点          | 忙标记在**每条结算路径**（成功、取消、异常）都复位                     | 第二次点"选图"毫无反应（标记卡在占用）            |
| 生物识别不可用                   | 拒绝放行（fail-closed）：拿不到明确"通过"就不给看                      | 指纹失败反而进了私密文件夹                        |
| 沉浸模式 show/hide 竞态          | hide 后延迟二次 hide、show 后延迟重铺背景（两条路径对称）              | 系统栏闪回、状态栏区域露白/露黑                   |
| Activity 销毁                    | 退全屏 custom view、`bridge.detach()`、清 Handler 队列、反注册网络回调 | 泄漏 + "退出后还能收到旧页面的回调"               |

---

## 6. 构建与发版要点

```bash
npm run build                # client/dist（APK 内嵌的就是它）
npm run android:test         # Kotlin 单测（44 例：Range/MIME/路径/缓存/桥协议/压缩判据/文件名，不需要真机）
npm run android:apk          # sync-web → gradlew assembleRelease（自动定位 JDK 21，打印 sha256）
npm run android:verify       # 解包发布产物自检：dist 一致 / 引用完整 / 桥方法名在 / Manifest 齐全
npm run android:preflight    # 验收前置检查：本地配置 + 线上 CORS/版本号/APK 是否就绪（不需要手机）
npm run android:device-check # 连真机后跑可脚本化的那半验收（安装/启动/日志/首帧/崩溃/截图 → 出报告）
npm run android:debug        # 调试包（.debug 后缀，可与 release 并存）
```

- Kotlin 单测为什么不用 `gradlew test`：工程路径含中文时，Gradle 给测试 worker 传 classpath 走
  `@argfile`（UTF-8 写入、java 启动器按系统 ANSI 代码页读取）→ 中文路径变乱码 → 测试类全部
  `ClassNotFoundException`（类其实已编译）。`android/scripts/run-kotlin-tests.mjs` 让 Gradle 只负责
  编译并导出 classpath 清单，再由 Node 直接起 JUnit（宽字符传参，不经过 argfile）。

- 版本号单一来源：`android/version.properties`
- 签名：`android/keystore.properties` + `android/app/k-release.keystore`（**必须备份**）
- 工具链：Kotlin **2.4.20** + Gradle **9.1.0** + AGP **8.13.0** + JDK **21**
  （Kotlin 官方兼容表：2.4.20 支持 Gradle 7.6.3–9.7.0、AGP 8.5.2–9.3.1）
- 发版连带项：`.env` 的 `APP_VERSION`/`APP_APK_URL`/`APP_UPDATE_NOTES`；服务器 `ALLOWED_ORIGINS`
  （改 `.env` 后必须 `pm2 delete + start`，`restart` 不重读 `.env`）
