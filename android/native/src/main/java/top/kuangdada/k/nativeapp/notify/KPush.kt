package top.kuangdada.k.nativeapp.notify

import android.app.Application
import android.content.Context
import android.os.Build
import android.os.SystemClock
import android.util.Log
import com.heytap.msp.push.HeytapPushManager
import com.heytap.msp.push.callback.ICallBackResultService
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import top.kuangdada.k.core.data.api.PushDeviceRequest
import top.kuangdada.k.nativeapp.AppGraph
import top.kuangdada.k.nativeapp.BuildConfig

/**
 * ============================================================
 * OPPO 离线推送（KPush）—— 设备注册 / 上报 / 解绑
 * ============================================================
 * ## 它解决什么问题
 *
 * 退到后台或被杀后，通知栏提醒由**系统推送服务**接收与展示（App 进程不参与）。
 * 本类负责把设备注册到 OPPO 通道，并把 registration_id 上报给服务端（服务端在
 * "手机不在线"时按它发推送，见 server/src/services/push.service）。
 *
 * ## 分工（改这里之前先读）
 *
 *  · **App 前台**：SSE 负责（RealtimeClient，连接带 `client=android`），KPush 什么都不做；
 *  · **App 退后台**：AppShell 在 ON_STOP 主动断开 SSE → 服务端视为"手机不在线" →
 *    发 OPPO 推送 → **系统推送服务展示通知**（点击深链回 App，见服务端的
 *    `action_parameters`）；App 进程此时参不参与都行 —— 通知栏消息不经过我们。
 *  · 因此本地**不需要**任何"收到推送后弹通知"的代码；KPush 只管注册/上报/解绑。
 *
 * ## 注册流程与失败处理
 *
 *  `init`（Application.onCreate）→ `isSupportPush`（非 OPPO/一加/realme 机型为 false，
 *  直接跳过注册，仅记日志）→ `register` → 回调 `onRegister` 拿到 regId →
 *  登录态下上报到服务端。
 *
 *  ## ★ 回调必须落在**主进程**（2026-10-08 事故，v0.1.15 修复）
 *
 *  SDK 的注册响应由系统推送服务（MCS）通过 `startService` 投递给 Manifest 里声明的
 *  `DataMessageCallbackService` / `CompatibleDataMessageCallbackService`，**在服务所在进程解析**——
 *  `PushService` 单例和 `ICallBackResultService` 回调都只存在于该进程的内存里。
 *  当时这两个服务被加了 `android:process=":push"`（那是阿里 mPaaS 适配层的写法，
 *  官方原生 SDK 的 Manifest 没有这一条），结果：回调全部落到 `:push` 子进程，
 *  主进程（UI）永远收不到 `onRegister` —— 注册永远停在"注册中"、错误码全部丢失
 *  （看起来像注册失败，其实是回调进了另一个进程，见 Manifest 里的长注释）。
 *  [init] 里的主进程守卫就是为此加的：真出了第二个进程也只会跳过注册 + 留日志，
 *  不会再把状态搅乱。
 *
 * ## 失败可见性（排查入口）
 *
 *  · `onRegister(code != 0)` → 按官方错误码表翻译成人话，写进 [Status.lastError]
 *    （随 ON_STOP 自检上报进服务端日志；`adb logcat -s KPush` 也直接可见）；
 *  · `onError` → 同样落进 [Status.lastError]（此前只打日志，外部什么都看不到）；
 *  · 30 秒超时看门狗 → 迟迟收不到任何回调时把"注册中"落成"失败（超时）"，
 *    否则状态会永远停在"注册中"（下次冷启动会自动重试）；
 *  · `onError(-1)`（SDK 频率限制，请求根本没发出去）→ 3 秒后自动重试一次。
 *
 * ## 解绑（退出登录）
 *
 * `unbindOnLogout` 必须在 `session.logout()` **之前**调用：它同步读到当前 Bearer 与
 * regId，然后 fire-and-forget 发 DELETE —— 否则登出后本地没了凭证，服务端那条绑定
 * 会一直留着，换人用这台手机就会收到上一个人的消息（隐私问题，不是观感问题）。
 */
object KPush {

    private const val TAG = "KPush"

    /** 与 SocialNotifier / NotifyPreference 共用同一个 prefs 文件（通知相关的偏好放一起） */
    private const val PREFS = "k_notify"
    private const val KEY_REGISTER_ID = "oppo_register_id"

    /**
     * 两次 `register` 之间的最小间隔（ms）。
     *
     * SDK 内部对同一命令有「1 秒内最多 2 次」的频率限制（超出走 `onError(-1)`，
     * 且请求根本不发出去），而 `register` 有冷启动 init 与登录成功两个天然调用点 ——
     * 不节流时多个调用点撞在一起就会触发限制（2026-10-08 排查时读 SDK 字节码确认）。
     */
    private const val REGISTER_THROTTLE_MS = 2_000L

    /** 等注册回调的超时（ms）：超时后把"注册中"落成"失败（超时）"，不留永远等待的状态 */
    private const val REGISTER_TIMEOUT_MS = 30_000L

    /** 被 SDK 频率限制挡下（onError(-1)）后的自动重试延迟（ms） */
    private const val RETRY_DELAY_MS = 3_000L

    /**
     * 推送注册状态（供 ON_STOP 自检上报与 `adb logcat -s KPush` 排查使用）。
     *
     * @param supported 设备是否支持 OPPO 推送（一加/realme/OPPO 且 ColorOS 3.1+）
     * @param registered 是否已拿到 registration_id
     * @param registering 已发出 register、正在等系统推送服务回调（与"失败"区分开）
     * @param lastError 最近一次失败原因（null = 没失败过）
     * @param serverBound regId **已确认上报到服务端**（上报成功置位、解绑清零）。
     *   它才是"后台提醒归厂商推送"的判定依据（`SocialNotificationCenter` 据此停用
     *   本地通知、`InboxPollCadence` 据此停后台轮询）：只有拿到 regId 不够——
     *   上报失败时服务端没有绑定，后台推送发不出来，本地兜底必须保持开启。
     */
    data class Status(
        val supported: Boolean = false,
        val registered: Boolean = false,
        val registering: Boolean = false,
        val lastError: String? = null,
        val serverBound: Boolean = false,
    )

    private val _status = MutableStateFlow(Status())
    val status: StateFlow<Status> = _status.asStateFlow()

    /** 幂等保护：`init` 只做一次（Application.onCreate 重复调用不该重复初始化 SDK） */
    private var initialized = false

    /**
     * Application 上下文：SDK 回调（`onRegister` 等）只带 result 参数、没有 Context，
     * 而回调是**进程级**的 —— 持 Activity 会泄漏，所以统一用 Application。
     */
    private var appContext: Context? = null

    /**
     * register 尝试的"代号"：每次发新请求自增。
     *
     * 看门狗与重试协程都先记住发起时的代号，回调/超时触发时再比对 ——
     * 只有"仍是最新一次尝试"才允许改状态，避免旧定时器覆盖新结果。
     */
    @Volatile
    private var generation = 0

    /** 上一次 register 的单调时钟（节流用，SystemClock 不受用户改时间影响） */
    private var lastRegisterAt = 0L

    // ------------------------------------------------------------------
    // 初始化与注册
    // ------------------------------------------------------------------

    /**
     * SDK 初始化 + 注册（在 `KApp.onCreate` 调用）。
     *
     * 未配置密钥（gradle.properties 缺 oppoPushAppKey/oppoPushAppSecret）时整体跳过：
     * 本地开发/测试无需 OPPO 配置，构建与运行都不受影响。
     */
    fun init(context: Context) {
        if (initialized) return
        initialized = true
        val app = context.applicationContext

        // 主进程守卫：回调只会落在"服务声明所在进程"，注册也必须发生在同一个进程（见类注释）。
        // 当前 App 是单进程（回调服务已不加 android:process），这里纯属防御 ——
        // 将来若有人给这些服务加了子进程，至少日志里一眼可见"为什么注册状态不动"。
        if (!isMainProcess(app)) {
            Log.w(TAG, "非主进程（${currentProcessName()}），跳过推送注册 —— 回调不会回到这里")
            return
        }
        appContext = app

        if (BuildConfig.OPPO_PUSH_APP_KEY.isEmpty() || BuildConfig.OPPO_PUSH_APP_SECRET.isEmpty()) {
            Log.i(TAG, "未配置 OPPO 推送密钥（gradle.properties），推送注册整体跳过")
            return
        }

        // init 不是耗时操作（官方说明）；needLog 用 DEBUG 开关控制 SDK 内部日志
        val initResult = runCatching { HeytapPushManager.init(app, BuildConfig.DEBUG) }
        if (initResult.isFailure) {
            val msg = "SDK 初始化失败：${initResult.exceptionOrNull()?.javaClass?.simpleName}"
            _status.value = Status(lastError = msg)
            Log.w(TAG, msg, initResult.exceptionOrNull())
            return
        }

        // 非 OPPO/一加/realme（或系统不支持）的机型：注册一定失败，提前判掉
        val supported = runCatching { HeytapPushManager.isSupportPush(app) }.getOrDefault(false)
        val cached = registerId(app)
        _status.value = Status(supported = supported, registered = !cached.isNullOrBlank())
        if (!supported) {
            Log.i(TAG, "此设备不支持 OPPO 推送（非 ColorOS/一加/realme 机型），跳过注册")
            return
        }

        register(app)
    }

    /**
     * 调一次 `register`（官方建议放在 Application.onCreate，可重复调用、SDK 侧幂等）。
     *
     * 无论有没有缓存 regId 都调：SDK 会用它自己维护的状态回调当前 regId，
     * 顺带覆盖"系统升级/清数据后 regId 变化"的场景（回调里会重新上报）。
     *
     * 自动调用点只有"冷启动 init"与"登录成功补报"两个，[REGISTER_THROTTLE_MS] 防止
     * 两者撞在一起触发 SDK 的频率限制。
     */
    private fun register(context: Context) {
        val now = SystemClock.elapsedRealtime()
        if (now - lastRegisterAt < REGISTER_THROTTLE_MS) {
            Log.i(TAG, "距上次 register 不足 ${REGISTER_THROTTLE_MS}ms，跳过本次（等回调即可）")
            return
        }
        lastRegisterAt = now
        val app = context.applicationContext
        appContext = app
        val gen = ++generation
        _status.value = _status.value.copy(registering = true, lastError = null)

        val result = runCatching {
            HeytapPushManager.register(
                app,
                BuildConfig.OPPO_PUSH_APP_KEY,
                BuildConfig.OPPO_PUSH_APP_SECRET,
                callback,
            )
        }
        if (result.isFailure) {
            val msg = "register 调用异常：${result.exceptionOrNull()?.javaClass?.simpleName}"
            _status.value = _status.value.copy(registering = false, lastError = msg)
            Log.w(TAG, msg, result.exceptionOrNull())
            return
        }
        armWatchdog(app, gen)
    }

    /**
     * 超时看门狗：register 发出后 [REGISTER_TIMEOUT_MS] 内没有任何回调（成功/失败都没有）时，
     * 把状态从"注册中"落成"失败（超时）"。
     *
     * 为什么必须有：`onRegister` 是**异步**回调（要走 MCS → 服务端 → MCS → 本地服务四步），
     * 任何一环静默失败都没有别的回调兜底 —— 没有看门狗的话，状态会永远停在"注册中"
     * （连失败都算不上），诊断上报与服务端日志都会看不到问题。
     */
    private fun armWatchdog(context: Context, gen: Int) {
        AppGraph.from(context).appScope.launch {
            delay(REGISTER_TIMEOUT_MS)
            // 代号比对：期间若有更新的一次 register / 已拿到 regId，本次看门狗自动作废
            if (gen == generation && !_status.value.registered) {
                _status.value = _status.value.copy(
                    registering = false,
                    lastError = "等待系统推送服务响应超时（${REGISTER_TIMEOUT_MS / 1000} 秒），下次启动自动重试",
                )
                Log.w(TAG, "注册回调超时（${REGISTER_TIMEOUT_MS}ms 内未收到 onRegister）")
            }
        }
    }

    /**
     * 登录成功后同步一次注册状态（由 AppShell 在登录态生效时调用）。
     *
     *  · 已有 regId（常见路径：本次冷启动 init 时已注册好）→ 直接上报（幂等 upsert）；
     *  · 还没有 regId（注册回调还没回来 / 之前失败过）→ 再 register 一次，
     *    回调 `onRegister` 里会补上报。
     */
    fun onLogin(context: Context) {
        val app = context.applicationContext
        appContext = app
        val cached = registerId(app)
        if (!cached.isNullOrBlank()) {
            upload(app, cached)
            return
        }
        if (_status.value.supported) register(app)
    }

    // ------------------------------------------------------------------
    // 上报 / 解绑
    // ------------------------------------------------------------------

    /** regId 回调（SDK 回调线程不保证是主线程；只做轻量状态更新 + 起协程上报） */
    private val callback = object : ICallBackResultService {

        override fun onRegister(code: Int, registerId: String?, pkg: String?, message: String?) {
            val context = appContext ?: return
            if (code == 0 && !registerId.isNullOrBlank()) {
                Log.i(TAG, "OPPO 推送注册成功：${mask(registerId)}")
                saveRegisterId(context, registerId)
                _status.value = Status(supported = true, registered = true)
                upload(context, registerId)
            } else {
                val msg = describeRegisterFailure(code, message)
                _status.value = _status.value.copy(registered = false, registering = false, lastError = msg)
                Log.w(TAG, "$msg（packageName=$pkg）")
            }
        }

        /** 我们**不在客户端**解注册（换账号只做服务端解绑，SDK 注册保持长活，见类注释） */
        override fun onUnRegister(code: Int, s: String?, s2: String?) {
            Log.i(TAG, "OPPO 推送注销回调：code=$code")
        }

        override fun onSetPushTime(code: Int, s: String?) = Unit

        override fun onGetPushStatus(code: Int, status: Int) = Unit

        override fun onGetNotificationStatus(code: Int, status: Int) = Unit

        override fun onError(code: Int, message: String?, pkg: String?, mini: String?) {
            Log.w(TAG, "OPPO 推送 SDK 错误：code=$code（$message）")
            if (code == -1) {
                /**
                 * `-1 = ERROR_CODE_REGISTER_API_FREQUENTLY`（注册频繁调用）——
                 * 意思是**请求被 SDK 的频率限制挡下、根本没有发给系统推送服务**，
                 * 因此不会有任何别的回调再来。安排一次延迟重试兜底，否则状态永远停在"注册中"。
                 * （正常路径不会走到这：我们有自己的 [REGISTER_THROTTLE_MS] 节流。）
                 */
                _status.value = _status.value.copy(lastError = "注册调用过于频繁，${RETRY_DELAY_MS / 1000} 秒后自动重试")
                scheduleRetry()
            } else {
                _status.value = _status.value.copy(
                    registering = false,
                    lastError = "SDK 错误 code=$code（$message）",
                )
            }
        }
    }

    /** 频率限制后的自动重试（只在"仍是最新一次尝试且尚未注册成功"时执行） */
    private fun scheduleRetry() {
        val context = appContext ?: return
        val gen = generation
        AppGraph.from(context).appScope.launch {
            delay(RETRY_DELAY_MS)
            if (gen == generation && !_status.value.registered) register(context)
        }
    }

    /**
     * 注册失败码 → 人话（官方《状态码定义》id=11224：0 成功；-1 服务不可用；-2 本地错误；
     * 11+ 为服务端返回）。翻译的理由：这些码会随 ON_STOP 自检上报进服务端日志
     * （`adb logcat -s KPush` 也直接可见），一串裸数字（"code=16"）没有可操作性，
     * 而每个码恰好对应一个可检查项。
     */
    private fun describeRegisterFailure(code: Int, message: String?): String {
        val base = when (code) {
            -2 -> "本地错误（SDK 判定不支持或参数缺失）"
            -1 -> "系统推送服务暂时不可用（稍后可重试）"
            11 -> "推送权限不足（OPPO 平台上该应用的推送服务未开通或被收回）"
            13 -> "调用次数超限（稍后重试即可）"
            14 -> "无效的 AppKey（与 OPPO 平台配置不一致）"
            16 -> "请求校验异常（常见原因：APK 签名/包名与 OPPO 平台登记的不一致）"
            17 -> "请求异常（缺少签名参数）"
            40 -> "缺少必选参数"
            41 -> "参数错误"
            else -> "错误码 $code"
        }
        val extra = message?.takeIf { it.isNotBlank() && it != "null" }?.let { "（$it）" } ?: ""
        return "注册失败 code=$code：$base$extra"
    }

    /** 上报 registration_id（仅登录态；未登录时只存盘，等登录后补报） */
    private fun upload(context: Context, registerId: String) {
        val graph = AppGraph.from(context)
        if (!graph.session.isLoggedIn) {
            Log.i(TAG, "未登录，暂不上报 regId（登录后会补报）")
            return
        }
        graph.appScope.launch {
            runCatching {
                graph.session.api.push.register(
                    PushDeviceRequest(
                        token = registerId,
                        packageName = context.packageName,
                        // 本机真实的「新消息」通道 id（可能带 `_g2` 后缀，见 SocialNotifier.messagesChannelId）——
                        // Android 9+ 的离线推送必须按它指定通道，否则系统不展示（2026-10-08 修复）
                        channelId = SocialNotifier.messagesChannelId(context),
                    ),
                )
                Log.i(TAG, "regId 已上报服务端（通道 ${SocialNotifier.messagesChannelId(context)}）")
                // 上报成功是整条链路的最终确认（设备注册 + 服务端绑定都成了），清掉历史错误；
                // serverBound 置位后：后台提醒归厂商推送，本地通知/后台轮询随之停用
                _status.value = _status.value.copy(lastError = null, serverBound = true)
            }.onFailure {
                // 上报失败不影响任何功能（下次冷启动/登录会再报），只留日志与诊断
                _status.value = _status.value.copy(lastError = "上报失败：${it.javaClass.simpleName}")
                Log.w(TAG, "regId 上报失败", it)
            }
        }
    }

    /**
     * 解绑（fire-and-forget）：把本机 regId 从服务端绑定里删掉，推送立即停止。
     *
     * **同步快照 Bearer 与 regId**，请求带显式 Authorization（见 PushApi.unregister 的注释）——
     * 退出登录时本函数必须在 `session.logout()` **之前**调用，否则本地凭证已清、
     * 服务端那条绑定会一直留着（换人用这台手机就会收到上一个人的消息，隐私问题）。
     */
    private fun unbind(context: Context) {
        val app = context.applicationContext
        val registerId = registerId(app)?.takeIf { it.isNotBlank() } ?: return
        val graph = AppGraph.from(app)
        if (!graph.session.isLoggedIn) return
        val bearer = graph.session.token?.let { "Bearer $it" } ?: return

        graph.appScope.launch {
                runCatching {
                    graph.session.api.push.unregister(
                        bearer,
                        PushDeviceRequest(token = registerId, packageName = app.packageName),
                    )
                    Log.i(TAG, "推送绑定已解除")
                    // 服务端绑定解除：后台提醒交还本地兜底（下次登录上报成功后再切回推送）
                    _status.value = _status.value.copy(serverBound = false)
                }.onFailure { Log.w(TAG, "推送解绑失败（忽略，下次登录会换绑）", it) }
        }
    }

    /** 退出登录前的解绑（**必须在 `session.logout()` 之前调用**，见 [unbind]） */
    fun unbindOnLogout(context: Context) = unbind(context)

    // ------------------------------------------------------------------
    // 进程判定
    // ------------------------------------------------------------------

    /** 当前进程名（API 28+ 用官方 API；27 读 /proc/self/cmdline 兜底） */
    private fun currentProcessName(): String? = runCatching {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            Application.getProcessName()
        } else {
            java.io.File("/proc/self/cmdline").readText().trim('\u0000', '\n')
        }
    }.getOrNull()

    /** 是否主进程（取不到名字时按"是"处理：宁可多跑一次注册，也不要静默什么都不做） */
    private fun isMainProcess(context: Context): Boolean {
        val name = currentProcessName() ?: return true
        return name == context.packageName
    }

    // ------------------------------------------------------------------
    // prefs
    // ------------------------------------------------------------------

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun registerId(context: Context): String? =
        prefs(context).getString(KEY_REGISTER_ID, null)

    private fun saveRegisterId(context: Context, id: String) {
        prefs(context).edit().putString(KEY_REGISTER_ID, id).apply()
    }

    /** 日志脱敏：regId 是设备级标识，不落全量 */
    private fun mask(id: String): String =
        if (id.length <= 12) id else "${id.take(6)}…${id.takeLast(4)}"
}
