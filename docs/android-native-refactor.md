# K 安卓端原生重写方案（独立工程 `android/` · 全 Kotlin 2.4.20 · v0.1.0）

> 状态：已评审通过，实施中。
> 本文件是方案的落库版本（决策 + 依据 + 验收），实施细节随进度在文末「实施记录」追加。

---

## 0. 已确认的决策（不再回头）

| 项          | 决定                                                             |
| ----------- | ---------------------------------------------------------------- |
| 老 APK      | **不保留、不兼容**：无数据迁移、无需沿用旧 origin、无回滚包袱    |
| 工程位置    | 提到根目录 **`android/`**，原生工程独立成品，与 `client/` 解耦   |
| 应用身份    | **全新 applicationId + 新 keystore**，包名默认 `top.kuangdada.k` |
| 版本        | **0.1.0 / versionCode 1**                                        |
| 语言        | **全部 Kotlin**（含看图器），Java→Kotlin 逐行为等价翻译          |
| Kotlin 版本 | **2.4.20**（最新正式版，2026-09-07）                             |
| 范围        | **全部原生能力**，分四波交付                                     |

---

## 1. 澄清：这些行为**本来就是原生实现的**，本轮只做等价迁移

高刷、状态栏/主题、沉浸模式、窗口背景、升级清缓存、看图器 —— **全部是既有原生实现，一行都不在 Web 层**。本轮不是"重新设计"，而是"换壳 + 换语言"。

**证据（现有代码全部是纯 Android API）**

- 高刷声明 `MainActivity.java:148-191`（`preferredDisplayModeId` / `preferredRefreshRate` / API35 `setFrameRateBoostOnTouchEnabled`）
- 状态栏透明 + 图标色 `:260-347`；沉浸 hide/show 对称兜底 `:378-441`；沉浸背景兜底 `:444-490`；窗口背景 `:531-558`
- 升级清 WebView 缓存 `:207-227`（`WebView.clearCache(true)` + `SharedPreferences("k_app").last_version_code`）
- 看图三件套 `ImageViewerActivity.java`(676 行) / `ZoomableImageView.java`(500 行) / `ImageLoader.java`(250 行)：全仓 grep **零 Capacitor 依赖**
- `MainActivity.java` 里的 Capacitor 耦合**只有 6 类**：`extends BridgeActivity`、`registerPlugin(NativeImageViewerPlugin)`、`getBridge()`（10 处）、`localServer.shouldInterceptRequest`、`bridge.launchIntent`、`bridge.getErrorUrl` —— **全是外壳与管线，没有一处落在行为逻辑里**

| 类别                                              | 内容                                                                                                                                                                                                                                                                                                                                                                                                      | 本轮实际工作                                                                                                | 风险                     |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------ |
| **A. 纯原生已实现（与 Capacitor 无关）**          | 高刷、状态栏/主题、沉浸 hide-show 对称兜底、沉浸背景兜底、窗口背景色、升级清缓存、看图三件套、Manifest 经验值（`configChanges` 全量 / `singleTask` / `adjustResize` / `largeHeap`）                                                                                                                                                                                                                       | **Java→Kotlin 等价翻译**：只把 `getBridge().getWebView()` 换成自有 `webView` 字段；注释里的真机结论原样带走 | 低                       |
| **B. Capacitor 替身（必须新写，契约不变）**       | 宿主壳（`BridgeActivity`→自研 Activity）、资源服务器（`WebViewLocalServer`→`WebViewAssetLoader` + Range）、插件桥（`@CapacitorPlugin`→`@JavascriptInterface`）、返回键（App 插件 `backButton`→`OnBackPressedCallback` + 桥）、文件选择/权限/全屏 custom view（原由 `BridgeWebChromeClient` 提供）、外链 `_system`（`bridge.launchIntent`）、错误兜底页（`bridge.getErrorUrl`）、版本信息（`App.getInfo`） | 新写                                                                                                        | **中（风险集中在这里）** |
| **C. Web 只提供"信号"（不是把原生能力搬到 Web）** | Hero 起止矩形（按 `devicePixelRatio` 量）、`willClose` 退场对齐、返回键裁决（模态 → 最深 `[data-back]` → 主 Tab 双击最小化）、沉浸意图（由 `requestFullscreen().then` 驱动）                                                                                                                                                                                                                              | 桥接层替换（`lib/native`）                                                                                  | 低                       |
| **D. 真·新功能**                                  | 四波原生能力（§8）                                                                                                                                                                                                                                                                                                                                                                                        | 新写                                                                                                        | 中                       |

> 一句话：**能力层等价迁移（不重新设计），只有宿主 / 资源服务器 / 桥三处换实现；D 类才是新写的。**

---

## 2. 版本与工具链定版（已查证，非推测）

**Kotlin 2.4.20**（Maven Central `kotlin-gradle-plugin` 与插件 marker `org.jetbrains.kotlin.android` 的 `latest`/`release` = 2.4.20，lastUpdated 2026-09-07）。JetBrains 官方兼容表：

| KGP                | Gradle（min–max） | AGP（min–max）   | 本工程                              |
| ------------------ | ----------------- | ---------------- | ----------------------------------- |
| **2.4.20（采用）** | 7.6.3–9.7.0       | 8.5.2–9.3.1      | ✅ Gradle 9.1.0 / AGP 8.13.0 均命中 |
| 2.4.0–2.4.10       | 7.6.3–9.5.0       | 8.5.2–9.1.0      | ✅ 但非最新                         |
| 2.3.20–2.3.21      | 7.6.3–9.3.0       | 8.2.2–9.0.0      | ✅ 但非最新                         |
| 2.2.20–2.2.21      | 7.6.3–**8.14**    | 7.3.1–**8.11.1** | ❌ 超上限（原先误选，已纠正）       |

- **Gradle 保持 9.1.0**、**AGP 保持 8.13.0**（均在 2.4.20 支持区间内）。AGP 最新稳定 9.4.0，但超出 2.4.20 保证区间（≤9.3.1）且 AGP 9 有破坏性变更 → 升 AGP 单列后续可选。
- **JDK 21**（`C:/Users/25359/.jdks/jbr-21.0.11`），`jvmTarget = JVM_21`；KGP 2.x 用 `kotlin { compilerOptions { ... } }`（`kotlinOptions{}` 已弃用）。
- 首次构建需从镜像拉取 2.4.20 的 KGP + 编译器（本机缓存只有 2.2.20，不可复用）。

---

## 3. 目标与验收标准

1. 纯原生 Android 工程：无 `com.getcapacitor:*`、无 `cap sync`、无 Cordova 插件机制。
2. UI 仍是现有 React 移动端（`client/dist` 内嵌 assets），**origin = `https://appassets.androidplatform.net`**，Web 侧只改桥接层。
3. **服务端同批改动**：CORS 白名单与预检头（§6.4），否则 App 内 API/SSE 会 403。
4. A 类行为**逐条保持等价**（真机清单为门禁，见 §10）。
5. 四波原生能力（§8）全部落地。
6. 自动化：client vitest 全绿 + 桥协议单测 + Kotlin 单测（协议/Range/MIME）+ server vitest（CORS）；`assembleRelease` 产出签名 APK。
7. 顺带修掉 §7 中在原生环境真实存在的两个缺陷。

---

## 4. 目标架构

```
React Web UI（client/dist → assets/web/**，origin https://appassets.androidplatform.net）
        ▲ │  window.KNative（唯一桥入口）
        ▼ │
Kotlin 原生宿主（MainActivity + WebView + 本地资源服务器 + 能力模块）
        │
        ▼  HTTPS / WSS  https://www.kuangdada.top（原生侧不参与业务请求）
```

### 4.1 origin 选择

**`https://appassets.androidplatform.net`**（`WebViewAssetLoader` 官方默认域）：HTTPS = 明确安全上下文（`getUserMedia`/`getDisplayMedia`/剪贴板行为与线上 Web 一致），不与真实站点或开发服务器混淆，APK 内不涉及明文放行。备选 `http://localhost` 同样要改服务端 CORS，省不了事。

**服务端配套（同批上线）**：`ALLOWED_ORIGINS` 增加该域（保留 `http://localhost` 便于调试，`pm2 delete + start` 生效）；`cors.ts` 预检头补两项；WS 信令不校验 Origin（已核实），新 origin 不影响语音。

### 4.2 资源域与 URL 空间

`assets/web/**` ← `client/dist/**`；URL 空间与 Web 构建**完全一致**（`/`、`/assets/*`、`/music/*`、`/favicon.svg`、`/theme-init.js`）→ Vite `base:'/'` 与所有绝对路径零改动。实现：`WebViewAssetLoader` + 自定义 PathHandler（`web/` 前缀、MIME 表 js/css/woff2/svg/json/png/jpg/webp/heic/mp3）+ **Range/206**。

### 4.3 桥协议契约（写入 `docs/android-native-architecture.md`）

- 注入：`addJavascriptInterface(KNativeBridge(activity), "KNative")`，注入前校验页面 origin。
- 同步读（返回 JSON 字符串）：`info()`、`backPressed()`、`prefsGet(key)`。
- 异步：`invoke(callId, method, paramsJson)` → 主线程执行 → `window.__KNative.resolve(id, ok, result)`；Web 侧 15s 超时 + `cancel(callId)`。
- 原生→JS 事件：`willClose` / `backPressed` / `appResume` / `deeplink` / `download` / `permission`。
- 版本协商 `KNative.version`；未知方法 `{code:'ERR_UNSUPPORTED'}`，Web 侧降级不抛异常。
- 线程纪律：JS 线程只入队；UI/WebView 只在主线程；长耗时（下载/解码）在工作线程并回主线程派发。
- **契约按 A 类既有语义 1:1 保持**：`viewer.open({images,index,headers,rect,rects})` → `{index}`；`viewer.close()`；`willClose` 在退场飞行动画**开始**时触发；`setImmersiveMode(bool)`；`setAppThemeMode(light|dark|system)`；`setWindowBackgroundColor(hex)`。
- 数据互通边界（**单一真相源，禁止双写**）：Web 拥有 `localStorage`（`k_token`/`theme`/`k_skip_update_version`/`k_viewer_hero`/房主令牌）；原生拥有 `SharedPreferences("k_app")`（键名 `k_native_` 前缀）；原生需要凭证时由 JS 显式传参（沿用 `authHeadersFor()`），**JWT 不落原生盘**。

---

## 5. 新工程骨架（`android/`）

```
android/
├── settings.gradle / build.gradle / variables.gradle / gradle.properties
├── gradle/wrapper/*（Gradle 9.1，腾讯镜像）+ gradlew(.bat)
├── local.properties（sdk.dir，不入库）
├── keystore.properties（新签名口令，不入库，必须备份）
├── version.properties（versionCode=1 / versionName=0.1.0）
├── scripts/{sync-web.mjs, gen-launcher-icons.mjs}
└── app/
    ├── build.gradle（namespace/applicationId top.kuangdada.k，signingConfigs，R8）
    ├── proguard-rules.pro（显式 keep @JavascriptInterface）
    ├── k-release.keystore（PKCS12，新）
    └── src/main/
        ├── AndroidManifest.xml
        ├── assets/web/**（构建产物，gitignore）
        ├── java/top/kuangdada/k/**（Kotlin，放默认 java 源集保证 AGP 稳定识别）
        └── res/**（颜色/主题/启动图/图标/file_paths，按需精简后迁入）
```

**Gradle**：`com.android.application` 8.13.0 + `org.jetbrains.kotlin.android` 2.4.20；`compileOptions` Java 21 + `kotlin.compilerOptions.jvmTarget = JVM_21`；依赖全部自有 —— `androidx.appcompat`、`androidx.core-ktx`、`androidx.activity-ktx`、`androidx.webkit:webkit:1.14.0`、`androidx.viewpager2`、`androidx.exifinterface`、`androidx.core:core-splashscreen`，（二期）`androidx.biometric`、`androidx.media`。

**签名**：`keytool -genkeypair -v -storetype PKCS12 -keystore app/k-release.keystore -alias k-native -keyalg RSA -keysize 4096 -validity 10000`；口令由我生成强随机值写入 `keystore.properties`（gitignore）并输出一次给你备份——丢失即无法原地更新。

**Manifest**：沿用 A 类经验值（`configChanges` 全量、`singleTask`、`adjustResize`、`largeHeap`、`hardwareAccelerated`）；新工程默认加固：`allowBackup="false"`、去 `requestLegacyExternalStorage`、`networkSecurityConfig` 默认禁明文。一期权限：`INTERNET`、`RECORD_AUDIO`、`MODIFY_AUDIO_SETTINGS`。

**`sync-web.mjs`**（取代易失败的 `cap sync`）：清空 `assets/web` → 复制 `client/dist/**`（排除 `apk/` 残留）→ 校验 `index.html` → 写 `build-info.json`。根 `package.json` 增 `android:sync` / `android:apk`。

**删除清单**：整个 `client/android/**`、`client/capacitor.config.ts`、`client/package.json` 中 7 个 `@capacitor/*` 依赖、根 `.gitignore` 的 capacitor 条目。

**流程更新**：`deploy.ps1`（第 68–69 行 → `android\...`）、`.gitignore`、README 构建三步、`.workbuddy/memory/MEMORY.md`（去掉 cap sync）、`.env` 的 `APP_VERSION=0.1.0` / `APP_APK_URL` / `APP_UPDATE_NOTES`。

---

## 6. 一期：A 类等价迁移 + B 类新写

### 6.1 Kotlin 模块（`app/src/main/java/top/kuangdada/k/`）

| 文件                             | 类别      | 内容                                                                                                                                                                                                                                                                                    |
| -------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MainActivity.kt`                | A（翻译） | **逐行为等价迁移** `MainActivity.java`：高刷、状态栏透明/图标色、沉浸 hide/show 对称兜底、沉浸背景兜底、窗口背景、升级清缓存、`onResume`/`onConfigurationChanged` 重放；`setDecorFitsSystemWindows(false)` + WebView 铺满（避让交给 CSS `env(safe-area-inset-*)`，不额外加边距）        |
| `bridge/KNativeBridge.kt`        | B（新写） | `@JavascriptInterface` 入口、方法分发、`callId` 关联、事件派发、主线程调度、origin 校验                                                                                                                                                                                                 |
| `bridge/BridgeMethods.kt`        | B（新写） | `info`/`prefs.get`/`prefs.set`/`minimizeApp`/`backPressed`/`statusBar.*`/`window.setBackgroundColor`/`immersive.setEnabled`/`external.open`/`viewer.open`/`viewer.close`                                                                                                                |
| `web/AssetServer.kt`             | B（新写） | `WebViewAssetLoader` + PathHandler（`web/` 前缀、MIME、Range/206）                                                                                                                                                                                                                      |
| `web/KWebViewClient.kt`          | B（新写） | 资源拦截、外链 `ACTION_VIEW`（替代 `bridge.launchIntent`）、错误兜底页（替代 `getErrorUrl`）、`onRenderProcessGone` 重建、`onReceivedHttpError` 日志                                                                                                                                    |
| `web/KWebChromeClient.kt`        | B（新写） | `onShowFileChooser`（多选 + `accept` → `EXTRA_MIME_TYPES`）、`onPermissionRequest`（麦克风/摄像头放行本域）、`onShowCustomView`/`onHideCustomView`（HTML5 全屏）、`onConsoleMessage`、`onJsAlert/Confirm/Prompt`                                                                        |
| `web/WebViewSetup.kt`            | B（新写） | 统一 `WebSettings`（对应 Capacitor `Bridge.initWebView`）：JS、**DOM storage**、`mediaPlaybackRequiresUserGesture=false`、`javaScriptCanOpenWindowsAutomatically`、缩放关闭、调试开关（debug 开）、`allowFileAccess=false`/`allowContentAccess=false`/SafeBrowsing                      |
| `feature/viewer/*.kt`            | A（翻译） | 看图三件套等价迁移：ViewPager2 翻页 + 捏合/平移/双击 + 下拉关闭（min(80dp,10%屏高) 或 >1100px/s）+ Hero 入场 + **反向 Hero 退场** + `willClose` 时点 + EXIF + 采样解码 + LruCache + 索引跟随 `onPageScrolled`；唯一改动：`NativeImageViewerPlugin.notifyWillClose` 静态调用改为新桥事件 |
| `feature/media/MediaPicker.kt`   | B（新写） | Photo Picker（API33+/androidx 兼容）→ `ACTION_GET_CONTENT` 兜底；相机 + FileProvider                                                                                                                                                                                                    |
| `core/Json.kt`、`core/Result.kt` | B（新写） | JSON 编解码、错误码、主线程工具                                                                                                                                                                                                                                                         |

### 6.2 Web 桥接层（TS）

- 新增 `client/src/lib/native/{index.ts,bridge.ts,types.ts}`，API 与 C 类信号一一对应：`isNative`、`getAppInfo`、`minimizeApp`、`onBackPressed`、`setStatusBarStyle`、`setStatusBarBackground`、`setWindowBackgroundColor`、`setImmersiveMode`、`openExternal`、`viewer.open/close/onWillClose`、`prefs.get/set`；浏览器环境全部降级为 no-op / `isNative()===false`。
- 替换点（14 个文件）：`config.ts`、`App.tsx`、`main.tsx`、`context/ThemeContext.tsx`、`hooks/useAndroidBackButton.ts`、`components/AppUpdatePrompt.tsx`、`lib/nativeImageViewer.ts`、`api/posts.ts`(5)、`hooks/useMediaDraft.ts`(2)、`components/post/CreatePost.tsx`(2)、`components/chat/Messages.tsx`、`lib/scroll.ts`、`voice/signaling/wsSignaling.ts`、`hooks/useFullscreenImmersive.ts`。
- 返回键：JS 仍是裁决者（模态 → 最深 `[data-back]` → 主 Tab 双击最小化）；原生取 `evaluateJavascript("window.__KNative.onBackPressed()")` 的**返回值**，300ms 无响应则 `moveTaskToBack(true)` 兜底。
- 测试：3 个 mock `@capacitor/core` 的文件改为 mock `lib/native`；新增 `lib/native/bridge.test.ts`；`nativeImageViewer.test.ts` 现有用例不变。

### 6.3 一期权限

见 §5 Manifest。

### 6.4 服务端改动（一期必做，否则部分功能 403）

移除 CapacitorHttp 后**所有请求改走 WebView 网络栈，受 CORS 约束**（现状经原生栈绕过 CORS）：

- `cors.ts` 的 `Access-Control-Allow-Headers` 增加 `X-Voice-Owner-Token`（`api/voice.ts` 删房/清聊天）与 `Cache-Control`（`api/posts.ts` 的 `getTempVideoStatus`）——否则预检失败；
- `ALLOWED_ORIGINS` 增加 `https://appassets.androidplatform.net`（`.env` + `.env.example`）；
- 加单测断言这两个头与白名单来源。
- 已核实无需改动：`/uploads` 与图片（`<img>` 不带 Origin）、大文件上传（`nativeFetchUpload` 本来走 `window.fetch` 直连）、WS 信令。

---

## 7. 顺带修正的既有原生缺陷

| 位置                                            | 问题                                                                                                            | 修法                                                                                           |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `client/src/components/post/CreatePost.tsx:130` | `window.location.origin + tempVideoUrl` 在原生下指向资源域 → 临时视频 HTTP 预览永远拉不到（表现为卡在"转码中"） | 改用 `resolveMediaUrl(tempVideoUrl)`；补单测                                                   |
| `client/src/hooks/useShareLink.ts:38`           | 原生下复制到剪贴板的是资源域链接（死链）                                                                        | 改用 `getServerUrl()` 拼链接；二期接系统分享                                                   |
| 全局约定                                        | `window.location.origin`/`location.host` 拼服务端资源在原生下必错                                               | 规则：服务端资源一律走 `config.ts` 的 `getServerUrl()`/`resolveMediaUrl()`；加 grep 守卫或单测 |
| `client/public/music/*.mp3`                     | 原生下音乐经 `resolveMediaUrl` 指向服务器，APK 内拷贝是死重量                                                   | 同步脚本支持 `--no-bundled-music`（先量体积再决定）                                            |

（`MusicEngine` 的 `window.location.origin + song.src` 比对无碍：原生下 `song.src` 已是绝对地址。）

---

## 8. 二期：原生能力（四波，D 类）

| 波次 | 能力                                     | 要点                                                                                                                                                  | 权限/Manifest                                                                    |
| ---- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| W1   | 文件与拍照、下载安装、系统分享、保存相册 | Photo Picker/相机 + FileProvider；`DownloadManager`（通知进度）+ `ACTION_VIEW(apk)`；`ACTION_SEND`；`MediaStore`（`Pictures/K`，<29 走 MediaScanner） | `CAMERA`(可选)、`REQUEST_INSTALL_PACKAGES`、按 API 分档存储权限                  |
| W2   | 通知 + 深链                              | `POST_NOTIFICATIONS` + `NotificationChannel`；SSE 驱动本地通知，点击经 `deeplink` 路由；`intent-filter`（站点域 + `ACTION_SEND`）→ HashRouter         | `POST_NOTIFICATIONS`                                                             |
| W3   | 后台音频 + PiP + 生物识别                | `MediaSessionCompat` + 前台服务 + 音频焦点；`setPictureInPictureParams`；`androidx.biometric` 锁私密文件夹（失败回退密码）                            | `FOREGROUND_SERVICE_MEDIA_PLAYBACK`、`USE_BIOMETRIC`、`supportsPictureInPicture` |
| W4   | 原生图片压缩/EXIF、系统信息面板          | 选图后原生采样+方向纠正；剪贴板/网络/电量/深色模式/存储余量经桥暴露                                                                                   | —                                                                                |

每项降级路径与验收写进 `docs/android-native-architecture.md`；未实现或失败一律降级到现有 Web 行为。

---

## 9. 三期：加固、观测、发布

- WebView 安全默认值（`allowFileAccess=false`、SafeBrowsing、禁明文、注入前 origin 校验、禁 `file://`）。
- 稳定性：`onRenderProcessGone` 重建 + 上报、`onReceivedHttpError` 归类日志、可选 `ApplicationExitInfo`、保留升级清缓存。
- 启动性能：`core-splashscreen` 统一启动图（沿用深色底与品牌图）、首屏埋点、高刷声明。
- 文档：新增 `docs/android-native-architecture.md`；更新 `docs/native-image-viewer.md`（路径与新桥）、README、MEMORY。

---

## 10. 验证与验收

**自动化**：client vitest（含新 bridge 测试）+ server vitest（CORS）+ `typecheck`/`lint`/`format:check` + Kotlin 单测（协议解析、Range 计算、MIME 映射）+ `assembleRelease` 成功并记录 APK 大小与 sha256。

Kotlin 单测的入口是 **`npm run android:test`**（`android/scripts/run-kotlin-tests.mjs`，44 例）：

| 用例文件                                     | 覆盖                                                                  | 为什么必须有                                                                 |
| -------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `web/AssetServerTest.kt`                     | Range 解析（11 例）、MIME 映射、URL→assets 路径、缓存策略、206 流边界 | `js` MIME 错一个字符就白屏；Range 算错音乐拖不动；`..` 没挡住是目录穿越      |
| `bridge/BridgeProtocolTest.kt`               | 参数解析（空/非法 JSON）、可选字符串、字符串数组、Hero 矩形换算       | 协议错了在真机上只表现为"某功能静默失效"，最难查                             |
| `feature/media/ImageCompressorTest.kt`       | 压缩判据（长边/体积阈值与边界）                                       | 压太少 → 9 张原图仍全尺寸进 WebView（历史闪退点）；压太多 → 小图白掉一次画质 |
| `feature/download/DownloadControllerTest.kt` | 文件名推导与净化                                                      | 文件名带路径分隔符时 DownloadManager 直接拒绝（真机只表现为"点了没反应"）    |

> **为什么不直接 `gradlew test`**：本工程路径含中文（`E:\资料\项目\k`），Gradle 给测试 worker 传
> classpath 用的是 `@argfile`（UTF-8 写入），而 java 启动器按系统 ANSI 代码页（GBK）读取 ——
> 中文路径被解成乱码（实测 `资料\项目` → `璧勬枡\椤圭洰`），于是全部测试类 `ClassNotFoundException`，
> 而类其实已经编译出来了。`android.overridePathCheck=true` 只解决了 AGP 的路径检查，管不到这一步。
> 换到纯英文路径下 `gradlew test` 正常。我们的做法是让 Gradle 只负责编译与解析依赖、
> 导出 classpath 清单，再由 Node 直接 `java -cp … org.junit.runner.JUnitCore`（命令行传参是宽字符）。

**A 类等价性门禁（真机清单，重点在"没变"）**

- 看图：`docs/native-image-viewer.md` §4 的 10 条全通过（Hero 双向、退场对齐、索引跟随、EXIF、鉴权图、失败退化、`k_viewer_hero=off` 开关）。
- 状态栏/沉浸：三态主题切换、全屏进出无黑白条（hide/show 对称兜底生效）、旋转与回前台重放。
- 高刷：真机 logcat 打印 mode/rate（沿用现有日志）。
- 升级清缓存：覆盖安装后资源为最新。
- 返回键：模态 → `[data-back]` → 主 Tab 双击最小化。
- 基础链路：登录、信息流、帖子/视频、聊天（含鉴权图）、私密文件夹、电子书、音乐（Range 与拖动）、语音房（麦克风/屏幕共享/录制）、发帖（多选/大文件分片/HEIC）、SSE 通知、更新弹窗下载安装。

---

## 11. 实施顺序与工作量

| 阶段    | 内容                                                                                                                                                                             | 预估       |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Phase 0 | 新工程骨架 + Kotlin 2.4.20 × Gradle 9.1.0 × AGP 8.13.0 冒烟（空模块 `assembleDebug`，验证首次拉取 2.4.20 构件）、生成新 keystore、真机确认纯 WebView 下 `getDisplayMedia` 可用性 | 0.5–1 人日 |
| 一期    | A 类翻译 + B 类新写（宿主/资源服务器/桥/Chrome 客户端）+ C 类桥接层 + 服务端 CORS + 真机清单 → **0.1.0 出包**                                                                    | 7–10 人日  |
| 二期    | 四波能力（W1→W4），每波独立出包                                                                                                                                                  | 15–20 人日 |
| 三期    | 安全/观测/启动性能/文档                                                                                                                                                          | 5–8 人日   |

**首批改动规模**：A 类翻译约 1450 行 Java → Kotlin；B 类新写约 1200–1800 行 Kotlin；C 类新增 TS 3 个、改 TS 14 个 + 测试 4 个；服务端 1 个文件；流程/脚本 5 个；文档 3 份。

---

## 12. 风险与假设

| 风险                                                          | 级别   | 对策                                                                |
| ------------------------------------------------------------- | ------ | ------------------------------------------------------------------- |
| **B 类适配层**（资源服务器 Range、桥、返回键、Chrome 客户端） | **高** | 契约按 A 类既有语义锁定 + 桥/Chrome 单测 + 真机点验                 |
| CORS 预检失败（语音房主令牌、视频状态轮询）                   | **高** | 一期同步改 `cors.ts` + 单测 + 真机点验这两条路径                    |
| A 类翻译引入偏差                                              | 中     | 逐行等价翻译 + 保留原注释中的真机结论 + 既有真机清单作为门禁        |
| Kotlin 2.4.20 首次拉取构件失败（镜像/网络）                   | 低     | aliyun + 腾讯镜像；Phase 0 先跑一次空模块构建                       |
| `<audio>` 无 Range → 音乐进度/拖动失效                        | 中     | PathHandler 明确实现 206 与 `Content-Range`；验收含拖动             |
| 麦克风/摄像头授权在 WebView 内失效                            | 中     | `onPermissionRequest` 放行本域 + 运行时权限 + 语音房回归            |
| R8 混淆掉 `@JavascriptInterface` 方法                         | 中     | proguard 显式 keep + release 包回归桥调用                           |
| 屏幕共享 WebView 不支持                                       | 中高   | Phase 0 真机判定；不支持则单独立项用 `MediaProjection` 原生捕获补上 |

**假设**（默认按此执行）：包名 `top.kuangdada.k`（生成 keystore 前可改）；服务器 `APP_VERSION` 同步改 `0.1.0`；`minSdk 24` / `compile`+`target 36`；部署仍走 `deploy.ps1`（仅 APK 路径改），CI 保持不含 Android 构建。

---

## 13. 实施记录

### 2026-09-12 · Phase 0（工程骨架 + 工具链定版）

- 新工程 `android/` 建立：`settings.gradle`（仅 `:app`）、`build.gradle`（buildscript classpath：AGP 8.13.0 + KGP 2.4.20）、`variables.gradle`、`gradle.properties`、Gradle 9.1 wrapper（腾讯镜像）、`local.properties`、`version.properties`（0.1.0 / 1）。
- app 模块：`namespace/applicationId = top.kuangdada.k`、Java 21 + `kotlin { jvmToolchain(21) }`、`buildFeatures.buildConfig`、debug 包 `applicationIdSuffix .debug`、release 开 R8 + 资源压缩 + 新签名。
- 资源从旧工程迁入并按新身份精简：主题（AppTheme / Launch / ImageViewer）、颜色、启动图、图标、`file_paths.xml`（改为只开放私有目录 + 缓存）、`network_security_config.xml`（**默认禁明文**）；删除 `values-night/styles.xml`、Capacitor 的 `package_name`/`custom_url_scheme` 字符串。
- **工具链冒烟通过**：`gradlew --no-daemon assembleDebug` → BUILD SUCCESSFUL（Kotlin 2.4.20 × Gradle 9.1.0 × AGP 8.13.0 × JDK 21 全部命中官方兼容区间）。过程中修掉两个真实问题：① XML 注释里不允许出现连续两个短横线；② Kotlin 块注释**可嵌套**，注释里写 `/assets/…` 那种通配写法会开启未闭合注释。
- 新签名生成：`android/app/k-release.keystore`（PKCS12 / RSA 4096 / 10000 天 / alias `k-native`）+ `android/keystore.properties`（不入库）。**旧 `com.k.app` 的 keystore 已备份到仓库外 `~/k-legacy-keystore-backup/`**。

### 2026-09-12 · 一期（A/B/C 三类 + 服务端配套）

- **A 类等价迁移**：`MainActivity.kt`（高刷 / 状态栏 / 沉浸 hide-show 对称兜底 / 窗口背景 / 升级清缓存 / onResume 与 onConfigurationChanged 重放）、`feature/viewer/*.kt`（看图三件套 695+ 行，行为逐条对齐；仅三处 Kotlin 层面的等价改名：`ImageLoader` 改 object、`PageHolder.position` → `boundPosition`（JVM 签名冲突）、监听器用匿名 object）；唯一实质改动：`NativeImageViewerPlugin.notifyWillClose` → `ViewerEvents.notifyWillClose`。
- **B 类新写**：`bridge/KNativeBridge.kt`（同步读 + invoke 分发 + 事件 + viewer 结果结算）、`web/AssetServer.kt`（WebViewAssetLoader + `web/` 前缀 PathHandler + MIME 表 + **Range/206** + 缓存策略）、`web/WebViewSetup.kt`、`web/KWebViewClient.kt`（外链跳转 / 渲染进程重建）、`web/KWebChromeClient.kt`（文件选择与拍照 / 麦克风摄像头授权 / HTML5 全屏 custom view / window.open）、`feature/media/CaptureFiles.kt`。
- **C 类网页侧**：新增 `client/src/lib/native/{bridge,index,types}.ts`（唯一桥入口，浏览器环境全量降级）；替换 14 个文件的 `@capacitor/*` 依赖点；`useAndroidBackButton` 改为「网页裁决 + 原生执行」；`ThemeContext` 三通道（图标色 / 状态栏底色 / 窗口背景）合并到 `lib/native`。
- **顺带修掉 3 个原生环境必现缺陷**：`CreatePost` 临时视频预览用 `window.location.origin` 拼接（App 内指向资源域，永远拉不到 → 卡在"转码中"）、`useShareLink` 分享链接同上（复制出死链）、两个图书页 `window.open('/api/books/...')` 相对路径（改为 `getApiBaseUrl()`）。
- **服务端配套**：`cors.ts` 预检头补 `X-Voice-Owner-Token`（访客房主令牌）与 `Cache-Control`（视频状态轮询），默认白名单加 `https://appassets.androidplatform.net`；新增 `server/test/cors.test.ts`（5 例，用 `vi.hoisted` 钉死白名单，不依赖本机 `.env`）；`.env` / `.env.example` 同步。
- **流程切换**：删 `client/android` 与 `client/capacitor.config.ts`；`client/package.json` 移除 7 个 `@capacitor/*` + CLI（`npm install` 少装 92 个包）；新增 `android/scripts/sync-web.mjs`（取代 cap sync，并写 `build-info.json`）与 `android/scripts/build-apk.mjs`（自动定位 JDK 21 + 传 JAVA_HOME + 打印 sha256）；根脚本 `android:sync` / `android:apk` / `android:debug`；`deploy.ps1` 改为读 `android/version.properties` 与新 APK 路径；`.gitignore`、README、`docs/android-native-architecture.md`、MEMORY 发版流程同步更新。
- **质量门禁**：client vitest 相关 5 个文件 65 例通过（含新增 `lib/native/bridge.test.ts` 13 例）、`tsc -b` 通过、prettier `format:check` 通过、`npm audit --omit=dev` 0 漏洞。
- **一期产物**：`npm run android:apk` → `BUILD SUCCESSFUL`，`app-release.apk` **13.20 MB**（旧 release 15.5 MB），sha256 `578b5719646268f57528afc55e73f423049560ac896ef76300f591038f392cd1`，已归档 `release/k-app-0.1.0-release.apk`；dex 字符串扫描确认 R8 未裁掉 `KNativeBridge` / `prefsGet` / `statusBar.setStyle` / `viewer.open` / `onBackPressed`（proguard keep 生效）。`.env` 的 `APP_VERSION`/`APP_APK_URL`/`APP_UPDATE_NOTES` 已切到 0.1.0（避免新包装上后提示"更新"回旧包）。
- **踩到并修掉的顺序坑**：第一次 `assembleRelease` 时 `client/dist` 还是改动前的旧产物（我的 TS 桥改动尚未 bundle），打出来的 APK 内嵌旧页面 —— 表现为"App 里所有原生能力静默失效"。已按 `npm run build` →（`npm run android:apk` 内部先 sync-web）的顺序重打，并校验 APK 内 `assets/web/index.html` 与 `client/dist/index.html` 完全一致、`assets/web/assets/*.js` 里确实含 `__KNative`。**发版顺序：先 build 再 android:apk，不可倒置**（`build-apk.mjs` 已把 sync-web 串在打包前，但 dist 本身必须是最新构建）。

### 2026-09-12 · 三期（安全加固 + 稳定性观测 + 启动性能 + 文档）

- **安全默认值复核与收口**（`web/WebViewSetup.kt`、`MainActivity.enforceJsInterfaceForUrl`）：`allowFileAccess`/`allowContentAccess`/`allowFileAccessFromFileURLs`/`allowUniversalAccessFromFileURLs` 全部 `false`、`mixedContentMode = NEVER_ALLOW`、显式 `setSafeBrowsingEnabled(true)`、`setSaveFormData(false)`、**关掉 geolocation**（全仓确认无 `navigator.geolocation` 调用）；**JS 桥改为按来源注入** —— 每次导航开始复核，非资源域立即 `removeJavascriptInterface`（外链本来就走系统浏览器，这是纵深防御）；WebView 远程调试仅 debug 包。
- **稳定性观测**（新增 `feature/diagnostics/Diagnostics.kt`）：① `ApplicationExitInfo`（API 30+）读取上次进程退出原因（`REASON_LOW_MEMORY`/`REASON_ANR`/`REASON_CRASH`…）落盘 + 日志 —— 移动端最常见的"App 在后台被清掉"终于有直接证据；② 渲染进程崩溃**跨启动累计**（偶发崩溃靠现场抓不到）；③ 首帧耗时埋点（`onCreate` → 首个内容可见）。三者经 `device.info` 暴露（`rendererCrashes`/`lastFirstPaintMs`/`lastExitReason`）并推 `perf.firstPaint`、`diagnostics.rendererGone` 事件，网页侧在 `useNativeDeviceStatus` 打一条 console 现场。
- **门禁**：client vitest **496 例（50 文件）全绿**（新增诊断事件 2 例）、`tsc -b` ✓、`eslint --max-warnings 0` ✓、prettier ✓；android `assembleDebug` + `assembleRelease` 均 BUILD SUCCESSFUL。过程中修掉 `ApplicationExitInfo.REASON_*` 常量挂错类（不在 `ActivityManager` 上）的编译错误。
- **产物**：`app-release.apk` **13.35 MB**，sha256 `366407bc557f6a08c4ca08713d605b2ec5e3c6816f37ae99d4151f6d8e110e13`，已归档 `release/k-app-0.1.0-release.apk`。APK 内校验：dist 与 `assets/web` 逐字节一致、bundle 含 `perf.firstPaint`、dex 含 `perf.firstPaint`/`diagnostics.rendererGone`/`REASON_LOW_MEMORY` 与诊断键名。

### 2026-09-12 · 二期 W4（原生图片压缩 + 系统信息）

- **选图压缩**：新增 `feature/media/ImageCompressor.kt`，接在 `KWebChromeClient` 的文件选择回调上 —— **在把 Uri 交回网页之前**先压一道。判据：长边 > 2560 或体积 > 1.5MB 才压（小图不重编码）；采样解码 + **EXIF 方向烘焙进像素**（不烘焙就会"预览正的、压缩后躺倒"）；GIF 跳过（重编码毁动画）；**任何一步失败都返回原 Uri**（压缩是优化，不能变成"选不了图"）。压缩在工作线程做，完成后回主线程回调；期间文件选择忙标记保持占用。收益：9 张相机原图不再以全尺寸进 WebView（JS 堆 ~256MB，历史上大文件上传闪退就出在这一段）。
- **系统信息**：新增 `feature/system/DeviceInfo.kt` + 桥方法 `device.info` —— 网络类型/是否在线/电量/充电/存储余量/深色模式/locale/SDK/机型，**全部只读、零权限**。网络变化经 `registerDefaultNetworkCallback` 转成 `network.changed` 事件（退出时用回调引用精确反注册）。
- **网页侧**：`lib/native` 增 `getDeviceInfo` / `onNetworkChanged`；新增 `hooks/useNativeDeviceStatus`（断网/恢复各提示一次 —— WebView 的 `navigator.onLine` 在部分机型恒为 true，断网时页面还以为在线）；`useMediaDraft` 在选大视频时**顺带用原生网络判定提示移动网络流量**（读不到就不提示）。
- **门禁**：client vitest **494 例（50 文件）全绿**（新增 W4 的 `device.info` 与网络事件 2 例）、`tsc -b` ✓、`eslint --max-warnings 0` ✓、prettier ✓；android `assembleDebug` + `assembleRelease` 均 BUILD SUCCESSFUL。过程中再次踩到 Kotlin 嵌套块注释（注释里写 `image/*` 会开启未闭合注释），已修并在文档里再次标注。
- **产物**：`app-release.apk` **13.35 MB**，sha256 `ff5945c2dea15e17a2e30aed8925dfb9c17637ca4c1d44ccaa35cb933a2b1fe4`，已归档 `release/k-app-0.1.0-release.apk`。APK 内校验：dist 与 `assets/web` 逐字节一致、bundle 含 `device.info`、dex 含 `device.info`/`network.changed` 与压缩产物目录名。

### 2026-09-12 · 二期 W3（后台音频 / 画中画 / 生物识别）

- **后台音频保活**：新增 `feature/media/PlaybackService.kt` —— 前台服务，类型 `mediaPlayback|microphone`。这不是可选优化：**Android 14+ 规定后台麦克风采集必须由带 `microphone` 类型的前台服务持有，否则语音房会被系统直接静音**；音乐/语音房在后台继续跑也需要前台服务，否则进程与 SSE 都会被回收。服务只管三件事：挂常驻通知（文案由网页给）、请求音频焦点并**把焦点变化转成事件**（`pause`/`resume`/`audioFocusLost`/`duck`）、通知栏"停止"→ `media.command{action:'stop'}`。网页侧 `hooks/useNativeForeground` 做优先级合并（语音房 > 音乐，一个服务两个来源）、切歌刷新文案、并处理命令（停止 → 退房/暂停；焦点丢失 → 暂停且记住"是系统停的"，焦点回来才恢复）。
- **画中画**：WebView 没有实现网页版 PiP（`document.pictureInPictureEnabled` 恒为 false —— 所以语音共享舞台的 PiP 按钮在 App 里以前根本不出现）。改为系统画中画：Manifest `supportsPictureInPicture="true"`，`MainActivity.onUserLeaveHint()` 在网页用 `pip.setEnabled` 声明时机（共享画面在放）时自动进小窗，`pip.enter` 供按钮主动触发，进/出小窗转 `pip.changed` 事件让网页精简 UI；`useCanvasVideoRenderer` 负责声明时机，`VoiceShareStage` 的按钮在原生宿主内改走 `pip.enter`。
- **生物识别**：新增 `feature/security/BiometricGate.kt`（`androidx.biometric`），允许**生物识别 + 设备凭据兜底**（只认指纹的话手指出汗/贴膜就直接进不去）；不可用时网页侧按原因隐藏入口而不是点了报错。解锁状态是**会话级且由网页持有**（`usePrivateFolder` 里的 ref），原生不缓存任何票据 —— "锁没锁"只有一处真相。
- **门禁**：client vitest **492 例（50 文件）全绿**（新增 W3 六个桥方法与事件的 6 例）、`tsc -b` ✓、`eslint --max-warnings 0` ✓、prettier ✓；android `assembleDebug` + `assembleRelease` 均 BUILD SUCCESSFUL（新增依赖 `androidx.biometric:1.1.0`，首次构建自动拉取）。
- **产物**：`app-release.apk` **13.35 MB**，sha256 `72eb5411a884a71cc7c5e986e0a3064b9a0d6c55be511aea13d09bcdcb5e3b91`，已归档 `release/k-app-0.1.0-release.apk`。APK 内校验：dist 与 `assets/web` 逐字节一致、bundle 含 `media.startForeground`、dex 含 `media.*`/`pip.*`/`biometric.*` 全部方法名与 `PlaybackService`、合并后 Manifest 含 `FOREGROUND_SERVICE(_MEDIA_PLAYBACK/_MICROPHONE)`、`USE_BIOMETRIC`、`supportsPictureInPicture="true"` 与 `foregroundServiceType="mediaPlayback|microphone"`。

### 2026-09-12 · 二期 W2（通知 + 深链 + 分享入口）

- **本地通知**：新增 `feature/notify/NotificationController.kt`（渠道 `k_default`、`ic_notification` 小图标、点击带 `k_deeplink` 回宿主）；桥方法 `notify.show` / `notify.status` / `notify.requestPermission`。网页侧新增 `hooks/useNativeNotifications`：SSE（私信/评论通知/公告）在 **App 切到后台时**投递到通知栏，前台不打扰；**只提醒"别人发给我"的私信**（自己其他端的回声不弹）；通知权限首次进入 5s 后请求一次，拒绝后不再反复索要。真·离线推送（App 被杀）需要 FCM/厂商推送，仍属独立立项。
- **深链**：`MainActivity.payloadFromIntent()` 把三类来源统一成 `deeplink` 事件 —— `ACTION_VIEW`（站内 https 链接被系统路由到 App）、通知点击（`k_deeplink` extra）、`ACTION_SEND`（文本/图片，「分享到 K」）；Manifest 增加 VIEW（`www.kuangdada.top` / `kuangdada.top`）与 SEND（`text/plain`、`image/*`）intent-filter。**冷启动时页面未就绪 → 原生先缓存、首帧可见后补发**（否则"点了通知没反应"）。网页侧 `hooks/useNativeDeeplink` 负责路由：`link` 直接 `navigate`；`text` 里是本站链接才跳（抽在 `lib/notifications.ts` 的 `parseSharedText`，站外链接一律不跳，避免被当站内路由后兜底回首页）；非链接文本复制并提示；图片分享当前只提示（落地为发帖属后续波次）。
- **测试**：新增 `lib/notifications.test.ts`（13 例：谁能弹/弹什么/去哪、站外链接与空 server 的边界、路径规范化）与 `lib/native/index.test.ts` 的通知+深链 3 例（方法名、参数形状、脏 payload 不炸调用方）。
- **门禁**：client vitest **486 例（50 文件）全绿**、`tsc -b` ✓、`eslint --max-warnings 0` ✓、prettier ✓；android `assembleDebug` + `assembleRelease` 均 BUILD SUCCESSFUL。
- **产物**：`app-release.apk` **13.22 MB**，sha256 `ca17f2b26831574c86ff318f1a752f55f7c052e36001f376e56c46bc66bb7d86`，已归档 `release/k-app-0.1.0-release.apk`。APK 内校验：dist 与 `assets/web` 逐字节一致、bundle 含 `notify.requestPermission`、dex 含 `notify.show`/`notify.status`/`notify.requestPermission`/`k_deeplink`、合并后 Manifest 含 `POST_NOTIFICATIONS` 与 VIEW/SEND intent-filter。

### 2026-09-12 · 二期 W1（下载与安装 / 保存到相册 / 系统分享）

- **下载与安装 APK**：新增 `feature/download/DownloadController.kt` —— 走系统 `DownloadManager`（后台/杀进程继续下载、通知栏进度、命中系统下载缓存）；下载完成广播 → 桥事件 `download {id,status,uri,fileName}`；APK 自更新用 `file.updateApk`（**下载完自动拉起安装**），未授予"安装未知应用"时**引导到系统设置**而不是静默失败；`file.installApk` 供手动重试。Manifest 增 `REQUEST_INSTALL_PACKAGES`。
- **保存到相册**：新增 `feature/media/MediaStoreSaver.kt` —— API 29+ 走 MediaStore（`Pictures/K`，`IS_PENDING` 防半张图，**不需要存储权限**），24–28 走公共目录 + `MediaScannerConnection`（Manifest 里 `WRITE_EXTERNAL_STORAGE` 用 `maxSdkVersion=28` 限定）。两个入口：原生查看器右下角新增「保存」按钮（带鉴权头抓原图，权限缺失先申请再继续），以及桥方法 `media.saveImage`（供网页侧调用）。
- **系统分享**：新增 `feature/share/ShareController.kt` —— 文本/链接直接 `ACTION_SEND`；图片先抓取到应用缓存再经 FileProvider 交给分享面板（直接给 http URL 多数应用不会去下载）。网页侧 `useShareLink` 在原生宿主内**在原有"复制链接"之外**额外拉起系统分享面板（复制行为与 tooltip 文案不变，面板被划掉时链接仍在剪贴板）。桥方法 `share.text` / `share.image`。
- **网页侧**：`lib/native` 新增 `downloadFile` / `updateApk` / `installDownloadedApk` / `onDownload` / `saveImage` / `shareText` / `shareImage`；`AppUpdatePrompt` 改为"DownloadManager 下载 → 完成自动安装"，并保留"入队失败/非原生 → 回退系统浏览器下载"的降级路径（下载中按钮显示"下载中…"，可点"后台下载"收起）。
- **新增守卫（两次踩坑换来的）**：`sync-web.mjs` 检测 `client/dist` 是否比 `client/src`/`shared/src` 旧 —— 旧则**直接报错退出**（附"先 `npm run build`"提示，`--allow-stale` 可跳过）。这两次都是"改了 TS 但没重新 build 就打包"，产物里是旧页面、App 内新功能静默失效；已实测三种路径（新鲜放行 / 陈旧拦截 / `--allow-stale` 放行）。
- **门禁**：client vitest **468 例（49 文件）全绿**（新增 `lib/native/index.test.ts` 9 例：方法名与参数形状、事件透传、非原生与失败时的降级）、`tsc -b` 通过、`eslint --max-warnings 0` 通过、prettier 通过；android `assembleDebug` + `assembleRelease` 均 BUILD SUCCESSFUL。
- **产物**：`app-release.apk` **13.21 MB**，sha256 `6afa71558793daf0a297a136dd4a1239ea42edb13c251ab1b896a1fd68caead3`，已归档 `release/k-app-0.1.0-release.apk`。APK 内校验：`assets/web/index.html` 与 `client/dist/index.html` 逐字节一致、web bundle 含 `file.updateApk`、dex 含 `file.download`/`file.updateApk`/`file.installApk`/`media.saveImage`/`share.text`/`share.image`、合并后 Manifest 含 `REQUEST_INSTALL_PACKAGES` 与 `WRITE_EXTERNAL_STORAGE(maxSdk=28)`。

### 2026-09-12 · 加固修订（对方案与实现做了一轮对抗式复核，19 项）

- **复核方式**：两个独立评审（一个只盯"原生↔网页契约与生命周期"，一个只盯"权限/降级/并发"）各出清单，合并去重成 19 项，逐条判断"会不会真的发生、触发条件是什么"，改完再回到 Kotlin 编译与 TS 门禁重跑。**不是为了好看，是因为这三条会直接伤到用户**：
  1. `allowContentAccess=false` → 文件选择器/拍照回传的是 `content://`，真机表现是"选完图没反应/上传空文件"。改为 `true`（`allowFileAccess` 仍为 `false`；提供器访问本身受系统权限与 SAF 约束）。
  2. 统一 15s 超时把两类"等用户"的调用误判为失败：`viewer.open`（看图时长不可控）超时后网页以为原生失败 → **叠一层 Web 全屏图**，关掉查看器后露出一层；`biometric.authenticate`（等人按指纹）超时被当作"原生不可用" → **放行私密内容**（fail-open，最严重）。改为逐调用 `timeoutMs`：`viewer.open`/`biometric.authenticate` 用 `0`（永不超时），`media.saveImage`/`share.image` 用 120s 覆盖大图抓取，其余默认 15s。生物识别同时改为 fail-closed：拿不到明确"通过"就不给看。
  3. 冷启动深链会丢：原生在"首个内容可见"就补发缓存事件，而那一刻 JS bundle 可能没执行完、React 订阅者更没注册 —— 用户看到"点了通知 App 打开了但没跳转"。改为**网页主动握手**（`KNative.webReady()` → 原生才补发），且 `lastDeeplink` 保留到被真正消费。
- **并发与竞态**（都是"第二次点就没反应"这类真机坑）：单槽位权限回调改 `ArrayDeque` 队列（原实现第二个请求顶掉第一个 → 网页永远等不到结果）；部分授权按资源分别记账（原来"只允许相机"会被当成"录音也允许" → 语音房静默不出声）；文件选择器忙标记在成功/取消/异常**每条**结算路径都复位（原实现异常时永久占用）。
- **生命周期与泄漏**：`onDestroy` 退全屏 custom view、`bridge.detach()`（防旧桥继续回调已销毁 Activity）、`removeCallbacksAndMessages` 清 Handler 队列、网络回调精确反注册；返回键 300ms 兜底 Runnable 在裁决返回后 `removeCallbacks`（否则每按一次返回留一个定时器）。
- **其它**：`media.startForeground` 回复补 `{requested:true}` 并新增 `media.foreground` 事件（网页端不再"发了不知道有没有生效"）；电量改走 `BatteryManager`（`registerReceiver(null)` 在部分 ROM 返回 null）；保存到相册权限被拒时**明确回调失败**而不是让网页白等；大视频的移动网络流量提示改为**先等 `device.info` 再提示**（顺序反了会先弹提示后判定）。
- **文档同步**：`docs/android-native-architecture.md` 补 `webReady`、逐调用超时表（含"不覆盖会怎样"）、完整事件表（`media.command`/`media.foreground`/`pip.changed`/`network.changed`/`perf.firstPaint`/`diagnostics.rendererGone`）、§5.1 的 `allowContentAccess` 刻意例外、新增 §5.3"并发与生命周期"；runbook 新增 §11 加固回归清单（这 19 项里**只能在真机上验**的部分）。
- **门禁**：client vitest **498 例（50 文件）全绿**（新增"`timeoutMs: 0` 永不超时"与"`webReady` 手势兼容老宿主"2 例）、`tsc -b` ✓、`eslint --max-warnings 0` ✓、prettier ✓；android `assembleRelease` BUILD SUCCESSFUL，且**Kotlin 编译告警清零**（顺手删掉 `getInsetsController` 的冗余空判与安全调用，剩下 3 条是框架自身的 deprecation）。
- **产物**：`app-release.apk` **13.35 MB**，sha256 `ce3f43be6cb17f40d10962a470148a2f5d7cd7363b9d722031c9ed9966a97bd9`，已归档 `release/k-app-0.1.0-release.apk`。APK 内校验：`assets/web/index.html` 与 `client/dist/index.html` 逐字节一致；32 个 JS chunk 含 `webReady`/`timeoutMs`/`perf.firstPaint`/`diagnostics.rendererGone`/`media.command`/`media.startForeground`/`device.info`/`biometric.authenticate`/`viewer.open`/`file.updateApk`/`notify.show`/`network.changed`；dex 含 `viewer.open`/`biometric.authenticate`/`media.saveImage`/`file.updateApk`/`notify.show`/`pip.setEnabled`/`network.changed`/`perf.firstPaint`/`webReady` 与 `PlaybackService`；合并后 Manifest 含 `FOREGROUND_SERVICE_MEDIA_PLAYBACK`/`FOREGROUND_SERVICE_MICROPHONE`/`USE_BIOMETRIC`/`REQUEST_INSTALL_PACKAGES`/`POST_NOTIFICATIONS`/`WRITE_EXTERNAL_STORAGE`/`supportsPictureInPicture` 与 `foregroundServiceType="mediaPlayback|microphone"`。

### 2026-09-12 · Kotlin 单测补齐（方案 §10 最后一格）+ 纯逻辑抽取

- **背景**：方案 §10 的自动化门禁里写着"Kotlin 单测（协议解析、Range 计算、MIME 映射）"，此前一直缺（只靠真机清单覆盖）。本轮补齐 —— 办法是先把这几处逻辑抽成**不碰 Android API 的纯函数**，于是能脱离设备跑。
- **抽取（行为不变，只改可见性与去重）**：`AssetServer` 的 `parseRange` / `assetPathFor` / `mimeOf` / `cacheControlFor` 移入 companion（无需 Context 即可调用）；`ImageCompressor.needsCompressionFor` 抽成判据（原先在 `needsCompression` 与 `compressIfNeeded` 里各写了一遍，判据分叉是"该压的没压/不该压的压了"的温床）；`DownloadController.defaultName` / `sanitize` 移入 companion；新增 `bridge/BridgeProtocol.kt`（参数解析、可选字符串、字符串数组、Hero 矩形换算），`KNativeBridge` 全部改用（8 处 `optString(…).takeIf { it.isNotEmpty() }` 收敛成一处语义，顺带删掉无人使用的 `JSONException` 导入）。
- **顺手修掉一个真缺陷**：`assetPathFor("")`（URL 没有 path，`Uri.getPath()` 返回空串）此前会拼出 `webindex.html` —— 查不到 → 404。现在归一化成根路径 → `web/index.html`。**这是新单测发现的第一个问题**。
- **环境坑（已写进 `android/gradle.properties` 注释）**：本工程路径含中文，Gradle 给测试 worker 传 classpath 用的是 `@argfile`（UTF-8 写入），而 java 启动器按系统 ANSI 代码页（GBK）读取 → 中文路径变乱码 → `gradlew test` 全部报 `ClassNotFoundException`，而类其实已经编译好了。实测证据：抓到的 argfile 里 `资料\项目` 用 GBK 解出来是 `璧勬枡\椤圭洰`；同一份 classpath 用 `java -cp` 直接给却能正常加载。`android.overridePathCheck=true` 只解决 AGP 的路径检查，管不到这一步。**结论：Kotlin 单测入口是 `npm run android:test`**（`android/scripts/run-kotlin-tests.mjs`：Gradle 只负责编译 + 把 classpath 导出成清单，Node 侧直接 `java -cp … org.junit.runner.JUnitCore`；宽字符传参 + 短 classpath 不会触发 argfile）。同时抽出 `android/scripts/gradle-env.mjs`（JDK 21 定位 + Windows .bat 调用）供单测与出包共用，避免"打包能过、单测跑不起来"这类只在一边暴露的问题。
- **门禁**：`npm run android:test` → **44 例全绿**（Range 11 例、MIME/路径/缓存 10 例、流边界 3 例、桥协议 14 例、压缩判据 6 例、文件名 6 例，其中 2 例就是修掉的缺陷与边界）；client vitest **498 例**、server vitest **297 例**、e2e **14 例** 全绿；`tsc -b` / `eslint --max-warnings 0` / `prettier` ✓；`assembleRelease` BUILD SUCCESSFUL 且 Kotlin 告警清零（顺手修掉 `MainActivity.applyStatusBarAppearance` 里 `getInsetsController(…) ?.` 的冗余安全调用）。
- **产物**：`app-release.apk` **13.35 MB**，sha256 `dd6f0c7ce2e76d3b456d558ad669d1f8f6333741870d6649e99485f2a6ff97f5`，已归档 `release/k-app-0.1.0-release.apk`。APK 内校验：`assets/web/index.html` 与 `client/dist/index.html` 逐字节一致；bundle 含 `webReady`/`timeoutMs`/`viewer.open`/`biometric.authenticate`/`device.info`；dex 含全部桥方法名与 `PlaybackService`（`BridgeProtocol` 这类 internal 单例被 R8 内联，属预期）。

### 2026-09-12 · targetSdk 36 设备级陷阱审计 + 发布 APK 自检脚本

- **审计（都是"编译期正常、真机才炸/才静默"的那一类）**，逐条看代码而不是猜：
  | 陷阱                                                  | 现状                                                                                                 |
  | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
  | `registerReceiver` 未声明导出性（Android 14 崩）      | ✓ `ContextCompat.registerReceiver(…, RECEIVER_EXPORTED)`（DownloadManager 广播由系统发出，必须导出） |
  | `PendingIntent` 未声明可变性（Android 12+ 崩）        | ✓ 3 处全带 `FLAG_IMMUTABLE`                                                                          |
  | 非 Activity 上下文 `startActivity` 缺 `NEW_TASK`      | ✓ 下载/分享/设置跳转都补了                                                                           |
  | 分享 Uri 缺 `FLAG_GRANT_READ_URI_PERMISSION`          | ✓ FileProvider + 授权标志齐备                                                                        |
  | edge-to-edge（targetSdk 35+ 强制）                    | ✓ `WindowCompat.setDecorFitsSystemWindows(window, false)`（宿主与查看器）                            |
  | 前台服务类型（Android 14 起必须）                     | ✓ `mediaPlayback+microphone`，权限与 Manifest 同步                                                   |
  | **`resolveActivity()` 受包可见性过滤（Android 11+）** | ✗ **缺 `<queries>`** —— 已修（见下）                                                                 |
- **修复 1 · 包可见性**：Manifest 增加 `<queries>` 声明 `IMAGE_CAPTURE` / `VIDEO_CAPTURE`。Android 11（API 30）起 `resolveActivity()` 也受包可见性过滤，不声明就是"相机明明装着也返回 null"，而 `KWebChromeClient` 正是靠它决定"走相机还是回落文件选择器"。**说明白边界**：网页侧的 file input 目前没有 `capture` 属性（`isCaptureEnabled` 恒为 false），所以这条路径今天是备用的、真机上暂时看不到"拍照"入口 —— 声明它是为了"要启用时只改网页一处"，而不是已经修好了一个用户可见的坏功能。
- **修复 2 · 选图卡死**：`KWebChromeClient` 启动相机与文件选择器全程 `try/catch` 并 `finish(null)` 结算。原来只 catch 了 `ActivityNotFoundException`：**任何其它异常一旦穿出 `onShowFileChooser`，`filePathCallback` 就永远不结算**，用户看到的就是"点选图完全没反应，只能重启 App"（上一轮修的忙标记复位是同一问题的另一半）。
- **新增 `npm run android:verify`**（`android/scripts/verify-apk.mjs`）：解包**发布产物**做四类校验——① `assets/web/index.html` 与 `client/dist/index.html` 逐字节一致（防"改了 TS 没重新 build 就打包"）；② index.html 引用的 `/assets/…` 全在包里（防"HTML 是新的、资源是旧的"）；③ web bundle 与 dex 里的桥方法名都在（**R8 裁剪/改名这类故障 debug 包看不出来，只有 release 会暴露**）；④ 合并后 Manifest 的权限/组件/包可见性齐全。以后每次出包都能一条命令复核，不必再手敲 `Expand-Archive` + 字符串搜索。
  - 顺带由它发现：`media.saveImage` / `share.image` 在 web 侧被 tree-shaking 剔掉了（`lib/native` 导出了但 App 内没有调用点 —— 保存相册是原生查看器自己的按钮，图片分享属后续波次），属预期，已在脚本里注明。
- **门禁**：`npm run android:verify` 全绿；`npm run android:test` 44 例全绿；`assembleRelease` BUILD SUCCESSFUL。
- **产物**：`app-release.apk` **13.35 MB**，sha256 `e032f13543074b6c07bfdc87c696c4059c817c0d5dfd358e60a0230b15183374`，已归档 `release/k-app-0.1.0-release.apk`。

### 2026-09-12 · 真机验收前置检查 + 设备自检（把"验收前该确认的事"自动化）

- **发现的真问题（都是"拿起手机才发现"的那类）**：新增的 `npm run android:preflight` 用 **App 的真实 Origin** 去请求线上服务，实测三条全部未满足：
  1. `GET /api/app/version`（带 `Origin: https://appassets.androidplatform.net`）→ **403 且无 CORS 响应头**。即：现在装上新 App，**所有 API/SSE 都会 403**（"能打开但处处报网络错误"）——服务器 `.env` 的 `ALLOWED_ORIGINS` 改动还没生效（需 `pm2 delete + start`）；
  2. 服务端仍广告 `version: 0.2.48`（旧的 Capacitor 包）：新 App 会弹"发现新版本"并去下载**另一个 applicationId** 的旧包，装上就是两个图标；
  3. `/apk/k-app-0.1.0-release.apk` 返回 **HTTP 200 但体积 0.00 MB** —— nginx 对不存在的路径回退 `index.html`，**状态码看不出来**，必须按体积/内容判断。APK 其实还没上传。
     这三条都由 `deploy.ps1` 一次性解决（打包 dist + `.env` + 单独上传 APK），所以验收顺序被写进 runbook §0：**先部署 → 前置检查全绿 → 再动真机**。
- **`npm run android:preflight`**（不需要手机）：本地配置一致性（版本号单一来源 vs `.env` 的 `APP_VERSION`/`APP_APK_URL`/`ALLOWED_ORIGINS`）+ 线上三项（真实接口带 Origin 是否放行、预检是否放行 `x-voice-owner-token`/`cache-control`、发布包是否真的在服务器上且体积正常）。
- **`npm run android:device-check`**（连手机后）：先跑前置检查，未就绪直接停下并说明要解决什么；就绪后自动完成**可脚本化**的那半部分——`adb install -r`、核对已安装 `versionName/versionCode`、`am start -W` 冷启动、抓过滤日志、断言 `onPageFinished https://appassets.androidplatform.net/index.html`、读 `KDiagnostics` 首帧耗时、扫 `FATAL EXCEPTION`、`pidof` 确认进程存活、`dumpsys activity exit-info` 取上次退出原因、`screencap` 截图，并把全部内容写成 `android/build/device-check/report-<时间>.md`（连同截图）——**一份能直接发我的现场报告**。交互类（Hero 转场、沉浸、指纹、画中画、后台麦克风、相册保存）仍然只能人看，照 runbook 走。
- **为什么值得做**：验收对象是"我改不了、你才能点"的部分，能脚本化的部分越自动化，交互部分留下的心力和误报越少；而且"服务器没部署"这种一票否决的问题，能在拿手机之前 10 秒暴露，不会浪费一轮真机往返。

### 2026-09-12 · 真机首跑：两个致命问题（都已修）+ 自检脚本的假阴性

**背景**：第一次在真机（OnePlus PGEM10 / Android 16 / API 36）跑自检，脚本报"全绿"，但**截图显示页面是 `404 Not Found` 文本** —— 说明断言太松。补上硬断言后抓到两个只有真机才暴露的问题：

- **① 资源路径映射错 → 整站 404（App 从未成功加载过）**
  `WebViewAssetLoader.PathHandler.handle(path)` 收到的是**去掉注册前缀之后的后缀路径，不带前导斜杠**：
  androidx 的实现是 `getSuffixPath(p) = p.replaceFirst(mPath, "")`，我们注册的前缀是 `"/"`，
  所以 `/index.html` 传进来是 `"index.html"`。而 `assetPathFor` 假定有前导斜杠 → 拼出 `webindex.html`
  → **每一个资源都 404**（页面显示 "404 Not Found"，但 `onPageFinished` 照样触发，所以只看"页面加载完成"的断言会误判通过）。
  修法：`assetPathFor` 先归一化前导斜杠（无则补 `/`），两种形状都映射正确。
  **根因是"两个调用方形状不同"**：Range 那条路我们自己传 `Uri.getPath()`（带斜杠），
  `PathHandler` 那条路是后缀路径（不带斜杠）。
  **教训**：我上一轮写的单测断言的是"我以为的输入形状"（`"/index.html"`），所以 **45 例全绿而真机全挂**。
  这次改为覆盖两种形状，并把 androidx 的字节码依据写进代码注释与测试注释里。
- **② 缺 `ACCESS_NETWORK_STATE`**
  `registerDefaultNetworkCallback` 直接抛 `SecurityException`（断网/恢复提示彻底失效），
  `activeNetwork` 也读不到 → `device.info` 恒报 `online:false/none`（会在启动时误报"网络已断开"）。
  已补声明（这是"读网络状态"权限，不是联网权限；`INTERNET` 不覆盖它）。
- **③ 自检脚本自身的假阴性/假阳性**（一并修掉，否则以后同类问题还会"全绿通过"）：
  - `adb install -r` 会让系统**自动重启**刚被杀的 App，于是"清日志 → force-stop → start"可能落在自动重启与手动启动的夹缝里：手动 `am start` 只是把既有实例拉到前台（`singleTask`），日志里自然没有 `WebView 已创建/onPageStarted`。改为 force-stop 后**等进程真的消失**，再清日志、再启动、再等新 pid，然后才取日志；
  - 新增两条硬断言：**主文档不得有 HTTP 错误**（不是 404 文本页）、**日志里不得有 SecurityException**（权限漏声明的典型信号）；
  - 线上包比较从"体积"改成"字节数"，并把"本地新构建 vs 线上旧包"的提示写清楚。

**修后实测（同一台手机）**：安装 ✓ · 冷启动 ✓ · `onPageFinished https://appassets.androidplatform.net/index.html` ✓ ·
主文档无 HTTP 错误 ✓ · 无 SecurityException ✓ · **首帧 256ms** · 无崩溃 ✓ · 进程存活 ✓ ·
`webReady` 握手 ✓（`KHost 网页侧握手完成（webReady）`）· 网页侧诊断 ✓（`KChrome [K] 原生首帧 256ms · 渲染崩溃累计 0 · 上次退出 REASON_EXIT_SELF`）。
截图确认首页信息流、图片、底部导航全部正常渲染。

- **Kotlin 单测**：45 例（路径映射补"无前导斜杠"一组）。
- **产物**：`app-release.apk` 13.35 MB，sha256 `8e0b8fb7856a549e19699342670f8411be32a45f6866d8f2d4f50bdb8a23eb3d`，已归档 `release/k-app-0.1.0-release.apk`。
- **注意**：线上仍是上一版（修前）的包（14002953 vs 新包 14002985 字节），**需要重新 `deploy.ps1`** 才能让下载地址给出修后的包。

## 14. 完成度审计（对照本方案逐条，2026-09-13）

状态口径：**✅ 完成并验证**（有命令/日志/截图证据）· **⚠️ 代码完成、真机待点** · **⬜ 未完成**。

### 14.1 §3 目标与验收标准（7 条）

| #   | 条目                                                                 | 状态 | 证据 / 说明                                                                                                                                                                                  |
| --- | -------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 纯原生工程，无 Capacitor/Cordova                                     | ✅   | `client` 依赖与 `android/` 里均无 `com.getcapacitor`；仓库内仅剩注释提及历史                                                                                                                 |
| 2   | UI 仍是 React 页面，origin = `https://appassets.androidplatform.net` | ✅   | 真机 logcat：`onPageFinished https://appassets.androidplatform.net/index.html`；截图首页正常渲染                                                                                             |
| 3   | 服务端 CORS 同批改动                                                 | ✅   | `android:preflight` 线上实测：`GET /api/app/version → 200, ACAO=…appassets…`、预检放行 `x-voice-owner-token`/`cache-control`；App 内请求已是 401（未登录）而不是 403                         |
| 4   | A 类行为逐条等价（真机清单为门禁）                                   | ⚠️   | 代码完成；**自动部分已过**（安装/冷启动/加载/首帧/无崩溃）；交互清单 §1–§13 未点                                                                                                             |
| 5   | 四波原生能力全部落地                                                 | ⚠️   | W1/W2/W4 完成；W3 的 `MediaSessionCompat`（锁屏/通知栏播放控制）**未做**（只做了前台服务+音频焦点+通知栏「停止」）→ 见 14.4                                                                  |
| 6   | 自动化门禁                                                           | ✅   | client vitest 502 · server 297 · e2e 14 · Kotlin 45 · `typecheck`/`lint`/`format:check` · `assembleRelease` · 另有 `android:verify`（发布产物四项自检）与 `android:device-check`（真机自检） |
| 7   | 顺带修掉 §7 的既有缺陷                                               | ✅   | `CreatePost` 用 `resolveMediaUrl`、`useShareLink` 用 `getServerUrl`；本轮补上**守卫测试**（`nativeOriginGuard.test.ts`）钉住这类误用                                                         |

### 14.2 一期（§5–§7）

| 范围              | 条目                                                          | 状态                                  |
| ----------------- | ------------------------------------------------------------- | ------------------------------------- |
| §5 骨架           | 独立工程、版本号单一来源、新 keystore、镜像仓库、启动图/图标  | ✅                                    |
| §6.1 A 类等价迁移 | 高刷 / 状态栏 / 沉浸 / 窗口背景 / 升级清缓存 / 原生看图三件套 | ✅ 代码；⚠️ 真机交互待点              |
| §6.2 Web 桥接层   | `lib/native` 三件套 + 14 处替换点 + 浏览器降级                | ✅                                    |
| §6.3 权限         | 麦克风/通知/存储分档/安装未知应用/前台服务类型/生物识别       | ✅（另修：补 `ACCESS_NETWORK_STATE`） |
| §6.4 服务端       | `cors.ts` 两个头 + `ALLOWED_ORIGINS` + 单测                   | ✅ 已部署并线上验证                   |
| §7 既有缺陷       | 临时视频预览、分享链接死链、全局约定守卫、音乐内嵌体积        | ✅ 四条全完成（音乐内嵌决策见 14.3）  |

### 14.3 二期 W1–W4（§8）与三期（§9）

| 波次 | 内容                                                                    | 状态        | 备注                                                                                                                                                                                                                                    |
| ---- | ----------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1   | 选图/拍照、下载与安装、系统分享、保存相册                               | ⚠️          | 实现完成（DownloadManager、FileProvider、MediaStore、Photo Picker）；真机交互待点。**本轮顺带**：APK 默认不再内嵌 `public/music`（原生一路 `resolveMediaUrl` 走服务器，实测服务器 `/music/*.mp3` 支持 206）→ APK **13.35 MB → 6.13 MB** |
| W2   | 通知 + 深链（含冷启动握手）                                             | ⚠️          | 实现完成（含 `webReady` 握手、三类深链统一）；真机交互待点                                                                                                                                                                              |
| W3   | 后台音频 + PiP + 生物识别                                               | ⚠️ **部分** | 前台服务（`mediaPlayback\|microphone`）+ 音频焦点 + PiP + 生物识别（fail-closed）完成；**`MediaSessionCompat` 未做**                                                                                                                    |
| W4   | 原生图片压缩/EXIF、系统信息                                             | ⚠️          | 实现完成（压缩判据有单测）；真机交互待点（本轮修掉缺 `ACCESS_NETWORK_STATE` 导致"恒报离线"）                                                                                                                                            |
| 三期 | 安全默认值、崩溃重建、`ApplicationExitInfo`、首帧埋点、启动图、三份文档 | ✅          | 真机已验证首帧埋点与退出原因落日志                                                                                                                                                                                                      |

### 14.4 还差什么（按优先级）

1. **交互类真机清单 §1–§13**（含 §11 加固回归 9 条）—— 只有你能点；我可以陪跑并抓 logcat/截图留证。这是"真机清单通过"这一验收项的**唯一**剩余部分。
2. **重新部署一次**：线上仍是 13.35 MB 的旧包（`14002985` 字节），本地新包 6.13 MB（`c7959066…`）；跑 `deploy.ps1` 即可（`android:preflight` 会比对字节数）。
3. **`getDisplayMedia`（屏幕共享）可用性判定** —— 唯一未定论的 Phase 0 遗留项；不可用则单独立项走 `MediaProjection`。
4. **`MediaSessionCompat`（锁屏/通知栏 播放/暂停/上一首/下一首）** —— 方案 §8 W3 的文字里有，实现时被记为"后续可选"。补齐它需要原生 + 网页两侧（网页侧要把 `media.command` 扩成 `play/pause/next/previous` 并接上播放器状态）。
5. **可选项（方案里本就标注为独立立项/未排期）**：`assetlinks.json` 免选择器深链、「分享到 K」图片落地为发帖、FCM/厂商离线推送、剪贴板 API、网页 file input 加 `capture` 启用已备好的「拍照」入口。
6. **（新方向，不在本方案范围）原生 UI 重写**：届时 WebView 与 JS 桥会被逐步替换成 Compose + 直接调用；可复用的是**原生能力模块与桥契约语义**，需要重做的是设计系统、路由、状态管理与各页面。等你要开工时我再出那一份方案。

**一句话结论**：方案里**代码与文档部分已 100% 完成并验证**（含两轮对抗式复核、Kotlin 单测、发布产物自检）；剩下的是「真机交互清单 + 一次重新部署 + 一个 MediaSession 补齐 + 一个屏幕共享判定」。

---

### 2026-09-13 · 关掉两个"方案里已点名"的尾巴（体积 + 守卫），真机自检全绿

- **音乐内嵌瘦身（方案 §7 第四条，之前只做了开关没做决策）**：原生端音乐一律经 `resolveMediaUrl` 指向服务器（实测服务器 `/music/*.mp3` 返回 **206**），内嵌副本是纯死重量 —— 两首 mp3 未压缩共 **7.4 MB**，占当时 APK（13.35 MB）一半还多。`build-apk.mjs` 现在**默认给 sync-web 加 `--no-bundled-music`**（`--with-bundled-music` 可显式回退），APK **13.35 MB → 6.13 MB**。网页端不受影响（浏览器的 `/music/*` 仍由站点自己发）。
- **origin 守卫补齐（方案 §7 第三条"grep 守卫或单测"）**：新增 `client/src/lib/nativeOriginGuard.test.ts` —— 用 `import.meta.glob(..., '?raw')` 扫全部生产源码，凡出现 `location.origin`/`location.host` 必须在白名单里写明理由（现为 3 处：分享链接的浏览器同源回落、MusicEngine 的 src 比较、WS 信令连当前宿主），并额外断言"白名单文件仍存在""`getServerUrl`/`resolveMediaUrl` 正例仍在"。这类误用在浏览器里永远正常、只有真机才断，所以值得静态钉死。
  - 过程踩了个小坑：客户端 tsconfig 不含 Node 类型，测试里 `import { readFileSync } from 'node:fs'` 过不了 `tsc -b`（vitest 用 esbuild 不报，所以先"测试全绿"再被 build 打回）—— 改成 Vite 的 raw glob 后两边都干净。
- **真机自检脚本再修一处假阴性**：`adb install -r` 之后系统要做 dexopt/索引，冷启动可能好几秒才走到 `createWebView`，而我原来是"固定等 7 秒再 dump 日志" → 日志为空、误报"没看到 onPageFinished"。改成**轮询到关键日志出现为止**（最多 25 秒，正常 1 秒内返回），并把 `am start -W` 的 `LaunchState/TotalTime` 写进报告。
- **真机复测（新包 6.13 MB，同一台 PGEM10 / Android 16）**：安装 ✓ · 冷启动 `LaunchState: COLD, TotalTime 553ms` ✓ · `onPageFinished` 本地资源域 ✓ · 主文档无 HTTP 错误 ✓ · 无 SecurityException ✓ · **首帧 252ms** · 无崩溃 ✓ · `webReady` 握手 ✓ · 截图首页正常。
- **产物**：`app-release.apk` **6.13 MB**，sha256 `c79590660b1ee7b8d970560db39d0fe1f369944c68e965ebcb40e636b42f035f`，已归档 `release/k-app-0.1.0-release.apk`。**线上仍是 13.35 MB 旧包**，需再跑一次 `deploy.ps1`。
- 另：新增 **§14 完成度审计**（对照方案逐条，含"还剩什么"）。

### 2026-09-13 · 真机交互验收（§3 看图）+ 修掉"压缩变负优化"

- **交互验收开始（OnePlus PGEM10 / Android 16）**：`§3 看图` 的 6 条核心手势（打开不闪、退回到第 3 张、下滑跟手/弹回、单击先缩回、放大退出起点、返回键一次退出）**实测无异常**；全程 logcat（`android/build/device-check/live-logcat-part1.txt`，110 行）**无崩溃、无 404、无 SecurityException**；截图确认原生查看器（纯黑背景 + 图片居中）与首页渲染正常。
- **日志里抓到一个用户看不见的真问题（已修）**：
  ```
  KImageCompress: 压缩 2700x1519/295198B → 2700x1519/342768B
  ```
  选图"压缩"把 295 KB 的图变成了 **342 KB**，尺寸还一点没变。根因两条：① 判据只看"长边 > 2560"就动手，而 `inSampleSize` **只能按 2 的幂降采样**，2700px 采不出结果 → 等于原尺寸重编码一次 q88；② 没有任何"结果是否真的更小"的校验 —— 源图本来压得狠时必然变大，白掉一次画质还多传几十 KB。这违反方案自己写的原则"压缩是优化，不能变成负优化"。
  - **修法**：新增 `scaledSizeFor()`（长边超阈值就**精确等比缩到 2560**，不再只依赖幂次采样）+ `smallerThanOriginal()`（**结果必须真的更小才采用**，否则删掉产物沿用原图）。两个都是纯函数，新增 9 例单测（Kotlin 单测 45 → **54 例**）。
- **产物**：`app-release.apk` **6.14 MB**，sha256 `deef8c58d30fe66f457c02d437d3a8593b002f437a6849acb04a68617ab5b2e6`，已归档 `release/k-app-0.1.0-release.apk`。
- **验收记录**已更新（runbook 顶部表格）：自动部分全绿 + §3 手势通过；§3 余项（EXIF 方向、鉴权图、断网退化、`k_viewer_hero=off`）与 §1–§13 其余待点。
- 过程中手机掉线（`adb devices` 为空），日志录制分段落盘（part1 保留），恢复连接后继续。

### 2026-09-13 · 冷启动深链改成自动检查（并把"杀进程点通知"这条从清单里去掉）

- **起因**：验收清单 §11.3 原本让人"杀掉 App 后点通知栏那条通知"，但用户实测发现 **ColorOS/一加在「清理后台」时会连带清掉该 App 的通知**，"通知还在、点它冷启动"这条路径在这类 ROM 上根本不存在。同时用户指出（正确）：**当前没接任何推送通道，App 被杀后不会有新通知**——这是方案里记录的已知边界，不是缺陷，但测试步骤写错了。
- **改法**：把这条做成**不依赖通知的自动化检查**，由 `android:device-check` 直接给宿主灌意图（等同用户在系统选择器里选了 K）：
  ① `ACTION_VIEW -d https://www.kuangdada.top/post/<真实帖子id>`（§9.5）；
  ② `ACTION_SEND --es EXTRA_TEXT <站内链接>`（§9.6）。
  判据：冷启动后日志出现 `处理意图 action=…` + `补发深链事件`（原生缓存意图、等网页 `webReady` 才补发），**并对每次落点截图留档**。帖子 id 从线上 API 现取（拿不到退回 1）。
- **实测结果（OnePlus PGEM10 / Android 16）**：两条都过，截图显示冷启动后**直接落在帖子详情页**（"2023年NBA季后赛第二场"那条视频帖）→ §9.5、§9.6、§11.3 **一次性通过**。
- **顺带确认一条产品规则（非缺陷）**：`ACTION_SEND` 进来时只有"文本本身就是站内链接"才跳转；**链接夹在文字里**（如"看看这个 https://…/post/99"）当前是**复制并提示**。已在 runbook 里写明，改不改由产品定（改法：抽出文本里第一个站内链接再路由）。
- 本轮同时把压缩负优化的修复包（6.14 MB）通过 `adb install -r` 装到真机。

### 2026-09-13 · 画中画小窗里显示的是"整个 App"而不是共享画面（已修）

- **用户实测发现**：进小窗后，小窗里看到的是 **App 的整页 UI**（房间头部/成员/聊天/控件），不是共享画面。
- **两个叠加的缺陷**（都在网页侧，原生侧只负责显示整个 Activity —— 这是系统 PiP 的固有语义）：
  1. **没有"精简 UI"**：`MainActivity.onPictureInPictureModeChanged` 每帧都在推 `pip.changed {inPip}`，
     注释也写着"便于隐藏页头/控制条等（画中画窗口很小，只该显示画面）"，但网页侧只拿它切了几个按钮的
     显隐（隐藏预览卡、隐藏 PiP/全屏按钮），**整页 UI 依然铺满视口** → 小窗自然显示整页。
  2. **共享画布在小窗里是冻帧**：`useCanvasVideoRenderer` 的绘制循环写着 `if (!live || pipActive) return;`
     —— 那行是为早已废弃的**浏览器版 PiP**（画布被搬到独立小窗、主文档里没人看）写的；而原生系统小窗
     恰恰相反：小窗显示的就是这一页，画布**就是**小窗内容，于是"进了小窗反而不画了"。
- **修法**：
  - 网页侧把舞台的画布槽位在 `pipActive` 时换成 `.pipCanvasSlot`（`position: fixed; inset: 0;` +
    高 z-index + 纯黑底）—— 同一层 DOM、画布不搬家，只靠 CSS 把画面铺满、其余 UI 压到底下，
    小窗里就只剩共享画面；
  - 绘制循环的暂停判据从 `pipActive` 改成 `document.pictureInPictureElement`（只有浏览器版 PiP 才对），
    并把 `pipActive` 从依赖数组里去掉；
  - 小窗层里**不放任何提示文案**（原"画面正在小窗中播放"会盖在画面上显示在小窗里，已移除）。
- **产物**：`app-release.apk` 6.14 MB，sha256 `7024102b82eefbe9cb1bcf23b3f10aec1bbf8600231e78b89883af2949c6d5a0`，已归档并 `adb install -r` 到真机等待复测。
- 待复测确认后再部署（避免反复上传）。

### 2026-09-13 · 切 tab 被当成"新页面"：握手作废 + 深链重复补发（潜伏 bug，已修）

- **线索来源**：复盘真机录制日志（`live-logcat-part3.txt`，344 行）时发现——**每次切页都打一行 `网页侧握手完成（webReady）`**（`#/announcements`、`#/books`、`#/voice`、`#/profile`…）。这不是噪音，是潜伏 bug 的表面。
- **根因在两侧**：
  - **原生**：`MainActivity.enforceJsInterfaceForUrl()`（由 `onPageStarted` 调用）**无条件**把 `webReady = false`（"新页面的 JS 要重新握手"）。可网页用的是 **HashRouter** —— 切 tab 只改 fragment，**文档根本没变**，WebView 却照样回调 `onPageStarted/onPageFinished`。
  - **网页**：`useNativeDeeplink` 的 effect 依赖 `navigate`，而 react-router 的 `useNavigate` **身份会随 location 变化**（v6.3+ 为了相对导航把 pathname 放进了它的 deps）→ 每切一次 tab 就"退订 + 重订 + 再握手一次"。
- **为什么危险**：宿主收到重复握手就会调 `flushPendingDeeplink()`，而它按设计**保留 `lastDeeplink`**（给渲染进程重建后补发用）→ **再补发一次**。于是"冷启动过深链"之后，用户**每切一次 tab 就会被弹回上次那个帖子**。本次会话恰好没有深链留存，所以没暴露。
- **修法（两侧一起，缺一不可）**：
  - 新增 `web/Navigation.kt`：`isSameDocument(previousUrl, currentUrl)` —— 比较时**忽略 fragment**，纯函数 + 5 例单测（切 tab / 同 URL / 路径不同 / 查询串变化 / null）；
  - `MainActivity`：只有**文档真的变了**才作废 `webReady` 与复位文件选择忙标记；
  - `useNativeDeeplink`：订阅与握手改成**空依赖**（每次文档加载只做一次），`navigate` 用 ref 持有（在 effect 里更新 —— 渲染期写 ref 会被 `react-hooks` 规则拦下）。
- **门禁**：Kotlin 单测 54 → **59 例**、client vitest 502 例、`tsc -b`/`eslint --max-warnings 0`/prettier ✓、`android:verify` 四项全过。
- **产物**：`app-release.apk` 6.14 MB，sha256 `29926aed73e05f9d6dd1f0c4fd46804ea92325a68992ca77612051a9acd3606b`，已归档；**已部署**（远端校验 sha256 一致，`[DEPLOY_VERIFY] PASS`）。
- **待复验**（手机断开，等接回）：冷启动后连点 3 个 tab → 日志里 `网页侧握手完成（webReady）` 应只出现 **1 次**（冷启动那次），且冷启动深链后切 tab **不再被弹回**原帖。

### 待办（下一步）

**方案内的工作已全部完成**（一期 A/B/C + 服务端配套、二期 W1–W4、三期加固与文档、Kotlin 单测补齐）。自动化门禁现状：client vitest 498 例、server vitest 297 例、e2e 14 例、Kotlin 单测 44 例（`npm run android:test`）、`typecheck`/`lint`/`format:check`、`assembleRelease`。剩下的是**我做不到、需要你在真机上确认**的部分：

1. **部署（必须先做，否则真机验收一定失败）**：跑 `deploy.ps1`——它会打包 `client/dist` + `.env`（`APP_VERSION=0.1.0`、`ALLOWED_ORIGINS` 含 `https://appassets.androidplatform.net`）、按 `pm2 delete + start`/`startOrReload --update-env` 生效、并把新版 APK 单独上传到 `/apk/k-app-0.1.0-release.apk`。**实测当前线上三条全不满足**：接口带 App Origin 返回 403、`/api/app/version` 仍广告 `0.2.48`、APK 路径回退成 index.html（200 但 0 MB）。部署完跑 `npm run android:preflight` 确认全绿。
2. **真机清单**：`npm run android:device-check` 先跑掉可脚本化的部分（安装/版本/冷启动/页面加载/首帧/崩溃/权限/截图 + 现场报告），再照 `docs/android-verify-runbook.md` 点交互项。覆盖：一期（看图 Hero 双向、沉浸进出、语音房麦克风、发帖选图/大文件、音乐 Range、返回键、更新弹窗）、W1（查看器「保存到相册」、分享面板、更新走 DownloadManager）、W2（后台通知/点通知直达/深链路由/分享到 K）、W3（后台麦克风保活、音乐后台继续、通知栏停止、共享画面按 Home 进小窗、私密文件夹生物识别）、W4（9 张相机原图发帖、断网与恢复提示）、三期（logcat `KDiagnostics` 的首帧耗时与"上次退出原因"；WebView 崩溃自动重建）、**加固回归（runbook §11 共 9 条：看图久留不叠 Web 图、指纹久等不放行、冷启动点通知直达、连点选图/选图卡死、权限队列与部分授权、大图保存/分享）**。
3. **Phase 0 遗留判定**：纯 WebView 下 `getDisplayMedia`（屏幕共享）可用性 —— 需真机确认，不可用则单独立项用 `MediaProjection` 原生捕获。
4. **后续可选项**（记录，未排期）：免选择器的深链需在服务器放 `/.well-known/assetlinks.json`；「分享到 K」的图片落地为发帖需要原生选取 + 上传通道；真·离线推送（FCM/厂商）；锁屏媒体控制（`androidx.media` 的 `MediaSessionCompat`）；剪贴板读写（网页 `navigator.clipboard` 在 https 资源域已可用）；网页 file input 加 `capture` 即可启用已备好的「拍照」入口。
