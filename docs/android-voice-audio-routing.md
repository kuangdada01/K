# 安卓语音房：蓝牙与耳机音频路由

> 更新日期：2026-10-02。
> 适用范围：`android/native` 原生语音房。本次修复耳机已连接但语音仍从手机扬声器播放的问题。
> 验证状态：**完整 debug 构建成功，402 项单元测试全部通过**（含新增 25 项路由回归测试）；真机验收待完成。
> 本次验证生成的 APK 与构建缓存已清理；交付保留可重建源码，不附 APK。

## 1. 行为约定

语音前台服务通过 `VoiceAudioRouter` 管理一次会话的通信音频路由，取消原先进入语音房时硬设扬声器的行为。
同一会话中的通知刷新和屏幕共享启动会复用已有路由，不重新初始化设备选择。

| 场景                   | 选择规则                                                     |
| ---------------------- | ------------------------------------------------------------ |
| 当前耳机仍可用于通话   | 保留正在使用的有线或蓝牙耳机，避免设备列表变化时无故切换     |
| 当前没有可保留的耳机   | 依次选择有线/USB、蓝牙、扬声器、听筒                         |
| 扬声器播放期间接入耳机 | 重新按上述规则选择耳机                                       |
| 耳机断开               | 只从当前可用设备中重新选择，不保留断开设备的路由             |
| 未识别的设备           | 不主动选择 `OTHER` 类型设备；各系统分支按下述规则回退        |
| 离开语音会话           | 注销监听、取消延迟任务，并释放本应用请求的通信路由与音频模式 |

这里的“蓝牙可用”指系统提供的通信音频能力。手机设置里仅显示蓝牙已配对或媒体音频已连接，
不能单独证明该设备支持当前语音通话输入/输出；播放方向和麦克风方向都要实机确认。

## 2. 按系统版本处理

### Android 12 及以上（API 31+）

`CommunicationVoiceAudioRouteBackend` 从 `AudioManager.availableCommunicationDevices` 读取可用输出设备，
调用 `setCommunicationDevice()` 请求路由。经典蓝牙 SCO、LE Audio 及系统暴露的助听设备按蓝牙类别参与选择；
只会选择系统实际列出的通信设备。

设备列表由 `AudioDeviceCallback` 监听，实际路由由 `OnCommunicationDeviceChangedListener` 确认。
请求成功受理不等于设备已经接通：等待期间保留异步请求，避免回调触发重复连接。
连接请求由纯 Kotlin 的 `VoiceAudioRouteController` 管理：每次最多等待 30 秒，同一目标最多连续尝试 2 次，
重试间隔 500 ms；持续失败后释放本应用请求，等待可用设备列表变化再重新选择，避免无限重试。
成功确认路由后重新获得完整重试次数；取消后的旧定时回调不能影响后续请求或新会话。

会话结束时仅在本应用曾成功提交选择的情况下调用 `clearCommunicationDevice()`。

### Android 8.1–11（API 27–30）

旧系统由 `LegacyVoiceAudioRouteBackend` 负责：查询已连接 HFP 耳机，处理 SCO 的异步建立、断开与有限重试。
HFP profile 代理尚未就绪时，以系统已列出的 SCO 音频端口作为后备依据；不把 A2DP 媒体连接当成通话能力。
已有 SCO 音频连接时复用，否则请求建立连接并等待状态广播。每次最多等待 4 秒，重试间隔 500 ms，
最多连续尝试 2 次；成功连接后清零失败计数。SCO 不受支持或尝试用尽时回退到可用有线设备或扬声器，
耳机断开重连后可重新尝试。
此分支通过 `startBluetoothSco()` / `stopBluetoothSco()` 申请和释放连接，不直接写全局 `isBluetoothScoOn` 开关。

结束会话时取消任务、注销设备/广播监听、关闭 profile 代理，并仅停止本应用发起的 SCO 请求。
扬声器开关只有仍等于本后端最后写入的状态时，才恢复进入会话前的值，避免覆盖期间其他来源的更改。

### 音频模式与权限

`VoiceAudioRouter.start()` / `stop()` 幂等。启动会话时申请 `MODE_IN_COMMUNICATION`；
结束时用 `MODE_NORMAL` 释放本进程的模式请求，不把进入房间前观察到的全局模式重新强设回去。

Manifest 新增的权限只有 `android.permission.BLUETOOTH`，并设置 `maxSdkVersion="30"`，供旧系统查询 HFP。
API 31+ 分支使用 `AudioManager` 通信设备接口，不直接访问 Bluetooth profile，不新增“附近设备”权限弹窗。
麦克风仍使用现有 `RECORD_AUDIO` 权限。

## 3. 文件与验证

下列源码位于 `android/native/src/main/java/top/kuangdada/k/nativeapp/voice/`：

| 文件                                     | 职责                                                       |
| ---------------------------------------- | ---------------------------------------------------------- |
| `VoiceForegroundService.kt`              | 会话服务持有路由器，服务销毁时停止路由并释放焦点           |
| `VoiceAudioRouter.kt`                    | 幂等生命周期、音频模式、按 API 版本选择后端                |
| `VoiceAudioRoutePolicy.kt`               | 可用设备之间的保留与优先级规则，独立于 Android API         |
| `VoiceAudioRouteController.kt`           | API 31+ 请求确认、有限重试、取消与退出的纯 Kotlin 状态机   |
| `CommunicationVoiceAudioRouteBackend.kt` | API 31+ 通信设备/路由监听、设备映射及 Android 请求接口适配 |
| `LegacyVoiceAudioRouteBackend.kt`        | API 27–30 HFP/SCO 路由与兼容处理                           |

测试位于 `src/test/java/top/kuangdada/k/nativeapp/voice/`，本次新增 25 项：

- `VoiceAudioRoutePolicyTest.kt`：12 项纯策略测试，覆盖入房前连接、房内连接、断开重连、有线拔出、
  当前耳机保留、设备顺序变化、过期设备 ID、类别优先级、同类首个设备、扬声器更新及未知/空设备列表。
- `VoiceAudioRouteControllerTest.kt`：13 项请求时序测试，使用模拟设备接口与时钟验证请求拒绝、超时、
  重复/同步/延迟回调、重试次数重置、最终失败回退、退出与旧会话定时回调失效等行为。

这些测试覆盖纯逻辑及模拟回调时序，不能证明真实 Android 设备回调、SCO 建链或实际音频输出已正常。

在仓库根目录运行：

```powershell
npm run android:test
npm run android:debug
```

环境配置见 [README](../README.md#6-构建-android-apk)。debug APK 可重新生成于
`android/native/build/outputs/apk/debug/native-debug.apk`；交付目录不附带 APK 或构建缓存。
本次 `npm run android:debug` 已成功，Gradle 输出 `BUILD SUCCESSFUL`（2 分 5 秒），100 项任务全部执行。
验证产物为 v0.1.20 debug、30.27 MB；SHA-256：
`c5fa69d0f8eca854ebe4d1119815cc8b49f164e6769ec0db795ac765b90aee59`。
该记录对应本次语音路由修复包，与此前图片查看器修复的构建记录分别保留。
`npm run android:test` 已成功：Gradle 输出 `BUILD SUCCESSFUL`（44 秒），JUnit 输出 **`OK (402 tests)`**，
覆盖 2 个模块、36 个测试类，包含新增 25 项音频路由测试。构建与测试通过不代表真实耳机路由已验收。

## 4. 真机验收清单

以下项目当前均为**待验收**。至少覆盖一台 API 31+ 和一台 API 27–30 设备；有条件时分别使用经典 HFP、LE Audio、有线和 USB 耳机。

| 操作                                  | 检查点                                                       |
| ------------------------------------- | ------------------------------------------------------------ |
| 先连接蓝牙耳机再入房                  | 对方声音从耳机播放；双方互相讲话，确认录音方向和音量可用     |
| 扬声器播放时连接耳机                  | 建链后转到耳机，连接期间不反复切换                           |
| 房内断开再连接蓝牙                    | 断开后有可用输出，重连后能再次使用耳机                       |
| 使用耳机时刷新房间通知、启动/停止共享 | 不被重新强制切到手机扬声器                                   |
| 多个耳机可用、插拔有线/USB            | 当前可用耳机保持；当前耳机移除后按优先级选择                 |
| 连接失败或暂时无法建立通话链路        | 有限重试后按对应版本的规则回退，无持续连接循环；记录实际输出 |
| 退房、被顶号、重复入退房              | 不残留通信模式或蓝牙请求；随后播放普通媒体检查路由正常       |
| 锁屏或切后台后继续通话                | 输入与输出持续可用，返回 App 后路由一致                      |

排查日志标签为 `VoiceAudioRouter`，旧系统后端另使用 `KVoiceAudio`。记录设备/Android 版本、耳机型号、连接类型、操作顺序、输入与输出结果，
并保存对应日志。历史语音房验收记录不覆盖本次路由修改。

## 5. 官方参考

- [AudioManager 通信设备 API](<https://developer.android.com/reference/android/media/AudioManager#setCommunicationDevice(android.media.AudioDeviceInfo)>)：API 31+ 的设备选择、返回值和会话结束时释放请求的约定。
- [Audio Manager self-managed call guide](https://developer.android.com/develop/connectivity/bluetooth/ble-audio/audio-manager)：VoIP 应用使用通信设备接口处理 LE Audio、异步确认与超时的指南。
