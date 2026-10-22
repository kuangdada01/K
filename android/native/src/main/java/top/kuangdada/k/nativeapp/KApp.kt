package top.kuangdada.k.nativeapp

import android.app.Application
import android.content.Context
import android.util.Log
import coil3.ImageLoader
import coil3.PlatformContext
import coil3.SingletonImageLoader
import coil3.disk.DiskCache
// `directory(File)` 是扩展函数（定义在 coil3.disk.diskCacheKt），不 import 会报
// "actual type is 'File', but 'Path' was expected" —— 编译器只看到 `directory(Path)` 那个成员
import coil3.disk.directory
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import top.kuangdada.k.core.data.AdminRepository
import top.kuangdada.k.core.data.BookRepository
import top.kuangdada.k.core.data.ComposerRepository
import top.kuangdada.k.core.data.CommentRepository
import top.kuangdada.k.core.data.FriendRepository
import top.kuangdada.k.core.data.InboxStore
import top.kuangdada.k.core.data.MessageRepository
import top.kuangdada.k.core.data.PostRepository
import top.kuangdada.k.core.data.RealtimeClient
import top.kuangdada.k.core.data.SessionRepository
import top.kuangdada.k.core.data.ThemePreference
import top.kuangdada.k.core.data.TokenStore
import top.kuangdada.k.core.data.UserRepository
import top.kuangdada.k.core.data.VoiceRepository
import top.kuangdada.k.nativeapp.notify.AppForeground
import top.kuangdada.k.nativeapp.notify.ForegroundRealtime
import top.kuangdada.k.nativeapp.notify.NotifyPreference
import top.kuangdada.k.nativeapp.notify.SocialNotificationCenter
import top.kuangdada.k.nativeapp.ui.AnimationGate
import top.kuangdada.k.nativeapp.ui.ImageLoading

/**
 * ============================================================
 * 原生版 Application
 * ============================================================
 * 用最朴素的「手动装配」而不是引入 Hilt/Koin：
 * 依赖图目前只有 8 个对象（TokenStore → SessionRepository → 各域仓库），
 * 引一个 DI 框架的收益（编译期校验、作用域管理）还不如它带来的构建复杂度。
 * 等模块数量涨到需要多作用域时再换 —— 换的成本主要在 [AppGraph] 一个文件。
 *
 * ⚠️ **必须在 AndroidManifest 的 `<application android:name=".KApp">` 里注册**。
 * 漏了那一行的话系统会用默认的 `android.app.Application`，`(application as KApp)` 直接抛
 * `ClassCastException` —— 而且**编译期完全看不出来**（本项目在真机上就是这么崩的第一次）。
 * [MainActivity] 因此做了兜底：取不到就自己建一个图并打一条显眼的警告，而不是崩溃。
 */
class KApp : Application(), SingletonImageLoader.Factory {

    lateinit var graph: AppGraph
        private set

    override fun onCreate() {
        // ⚠️ 必须在最前面：装晚了会漏掉启动阶段的崩溃（见 CrashLog 的注释）。
        // 只留一份现场文件，不改任何崩溃行为，下次启动由 AppRoot 弹出来。
        CrashLog.install(this)
        super.onCreate()
        /*
         * 键盘高（= 输入区功能面板高）的落盘恢复，必须在这里、早于任何一帧。
         *
         * 面板要和键盘**等高**才能原地换位、输入栏不动（QQ/微信那套）。以前这个值只在
         * 进程内存里，冷启动就忘光 —— 用户"打开 App 直接点表情"看到的是按屏高估的
         * 高度，弹过键盘后再点又变成真实键盘高，这就是"消息页有两种高度"。
         * 见 KeyboardHeightMemory 的注释。
         */
        top.kuangdada.k.nativeapp.ui.KeyboardHeightMemory.install(this)
        graph = AppGraph(this)
        /*
         * 屏幕共享渲染器持有者的装配点（M6.17）。
         *
         * **必须在这里，不能放到房间页的组合里**：持有者是跨 Activity 的单例（全屏宿主也要用它），
         * 而组合的执行顺序由调用点决定（`bindTrack` 在页面函数体、真正的容器在更深的位置）——
         * 一旦"建渲染器"早于"装配上下文"，真机表现就是**一进房就闪退**
         * （`lateinit property appContext has not been initialized`，实测崩在 ShareRenderHolder）。
         * 放在 Application.onCreate 之后，"上下文一定已就绪"就是结构性保证，不依赖调用顺序。
         */
        top.kuangdada.k.nativeapp.voice.ShareRenderHolder.install(this)
        // 语音房活动会话持有者同样装配为进程默认：前台服务（无 Activity 上下文）与
        // 各控制器经 VoiceRoomSessionHub.get() 取到同一个实例，通知退房才能路由到控制器
        top.kuangdada.k.nativeapp.voice.VoiceRoomSessionHub.install(graph.voiceHub)

        /*
         * 「App 在不在前台」的进程级判定 + 事件→通知的进程级消费者。
         *
         * 两者都必须在 Application 里装配，**不能挂在组合树上**：
         *  · 前台判定被通知中心用（Activity 被回收后它还得能回答"我在不在前台"）；
         *  · 通知中心要在 Activity 销毁后继续工作 —— 否则进程活着、SSE 连着，
         *    通知却没人发。
         */
        graph.foreground.install(this)
        graph.notificationCenter.start()
        // 收件箱订阅事件流：任何"可能改变未读"的事件都立刻刷一次（角标与消息页共用的那一份状态）
        graph.inbox.start()
        /*
         * SSE 连接 / 收件箱对账 / 诊断上报的**进程级联动**（2026-10-10）。
         *
         * 连接条件 = `前台 && 已登录`（进程级）。不能留在 AppShell 的 Activity 生命周期上：
         * Activity 生命周期会因转屏、多窗口、系统回收等频繁抖动，一旦误判离线，
         * SSE 被掐断 → 服务端转投系统推送 → 用户对着开着的 App 收到重复提醒。
         * 详见 ForegroundRealtime 的类注释。
         */
        graph.foregroundRealtime.install()

        /*
         * OPPO 离线推送：设备级注册。
         *
         * 只做"设备级注册"（SDK init + register → 拿 registration_id），
         * **是否上报给服务端**由登录态决定（见 KPush.upload：未登录只存盘，登录后补报）——
         * 放这里是因为官方建议在 Application.onCreate 注册（提高注册率），
         * 且它不涉及任何登录态判断，失败也只记状态不打断启动。
         * 未配置密钥（gradle.properties）时整体跳过，见 KPush.init。
         */
        top.kuangdada.k.nativeapp.notify.KPush.init(this)

        /*
         * 通知渠道：确保存在 + **一次性自动修复"被系统静默"**（2026-10-07）。
         *
         * 背景：真机上出现过"通知能弹出来，但没有声音和震动" —— 上报回来的取值是
         * `channelSound=null` + `channelVibrate=false`，而渠道重要性明明是 HIGH，
         * 也就是渠道被 ROM 的通知管理默认按"静默"处理了。渠道的提示音/震动**创建后不可改**，
         * 所以这里在启动时检测一次：确实被静默了就换一个新 id 重建（只做一次，
         * 之后若用户自己关掉就不再抢，见 SocialNotifier.migrateSilentChannelIfNeeded）。
         */
        top.kuangdada.k.nativeapp.notify.SocialNotifier.ensureChannels(this)
        top.kuangdada.k.nativeapp.notify.SocialNotifier.migrateSilentChannelIfNeeded(this)
    }

    /**
     * 图片加载器的**唯一入口**（Coil 3 的 `SingletonImageLoader` 会调它）。
     *
     * 为什么必须在这里配、而不是用默认的：默认加载器把取图与解码都丢给 `Dispatchers.IO`
     * （突发时可以开出几十个线程），转场动画正好在那段时间跟它们抢 CPU —— 用户看到的就是
     * "动画时不时掉帧"。这里换成两根轴：
     *
     *  · **限并发 + 低线程优先级**（见 [ImageLoading]）：图片慢一点出来可以接受，动画不能卡；
     *  · **动画期间在门口排队**（[AnimationGate]）：转场/查看器飞行进行时，新发起的取图/解码
     *    推到动画结束后再开工，动画帧独占 CPU。
     *
     * 只改 `fetcherCoroutineContext` / `decoderCoroutineContext`：**拦截器链与内存缓存不动** ——
     * 它们要留在调用方线程上"立刻返回"，否则内存里已经有的图也会被排到动画后面，
     * 列表会先空一块再补上。查看器自己的请求另外走 `ImageLoading.immediate`。
     *
     * ## ★★ 必须显式指定 `diskCache`（否则 Coil 3 的默认磁盘缓存是坏的）
     *
     * 用户反馈："**每次退出重新进 App 还是会加载自己的头像**" —— 根因就在这里。
     *
     * Coil 3 不配 `diskCache` 时的默认值是它的 `singletonDiskCache()`：
     *
     * ```
     * DiskCache.Builder().directory(FileSystem.SYSTEM_TEMPORARY_DIRECTORY / "coil3_disk_cache")
     * ```
     *
     * 而 Okio 在 **Android** 上把 `SYSTEM_TEMPORARY_DIRECTORY` 解析成
     * `System.getProperty("java.io.tmpdir")` —— 也就是 **`/data/local/tmp`**。
     * 那个目录属于 `shell` 用户（真机实测 `drwxrwx--x shell shell`），
     * **App 进程根本没有写权限**，于是：
     *
     *  · 磁盘缓存**一次都没写成**（真机 `ls /data/local/tmp` 里查无 `coil3_disk_cache` 目录）；
     *  · 失败还是**静默**的（Coil 不会因为缓存目录写不进去就报错）—— 内存缓存一命中就一切正常，
     *    所以只有**冷启动**那一刀露馅：进程被杀 = 内存缓存清空 →
     *    每一张图（头像、列表配图、封面）都得重新走网络。
     *
     * 表现之所以是"**只有自己的头像最明显**"：头像在聊天/发布/主页多处出现、尺寸小、加载快，
     * "该瞬间出现却空了一下"的对比最刺眼；帖子配图有 shimmer 占位兜着，反而看不出。
     *
     * 修法就是钉一个**属于本 App 的**缓存目录：`context.cacheDir`
     * （= `/data/user/0/<pkg>/cache`，系统会在空间紧张时自动回收，正合"可再生的图片缓存"这个语义）。
     */
    override fun newImageLoader(context: PlatformContext): ImageLoader =
        ImageLoader.Builder(context)
            .fetcherCoroutineContext(ImageLoading.gated)
            .decoderCoroutineContext(ImageLoading.gated)
            .diskCache {
                DiskCache.Builder()
                    // 必须落在 App 自己的 cacheDir 下 —— 不能用 Okio 的临时目录（见上面那段）
                    .directory(context.cacheDir.resolve("image_cache"))
                    // 250MB 是 Coil 的默认值；显式写出来是为了让"缓存上限"这件事在代码里看得见
                    .maxSizeBytes(250L * 1024 * 1024)
                    .build()
            }
            .build()
}

/** 进程级依赖图（单例式：一个进程一份） */
class AppGraph(app: Context) {

    private val appContext = app.applicationContext

    val tokenStore: TokenStore = TokenStore(appContext)

    init {
        /**
         * 预热身份快照（头像地址 / 昵称）。
         *
         * 放在这里而不是懒加载：此刻是 `Application.onCreate` 的主线程，
         * **还没有任何一帧要画**，读盘（加密 prefs 要过 Keystore）慢一点也无所谓；
         * 等到 `AppShell` 取值时已经是内存读取 → 首帧就能拿到头像地址。
         *
         * 不预热的话，冷启动进消息页会出现"**自己的头像先空/先默认人像、再变真头像**"
         * （用户实测反馈），根因见 [TokenStore.warmIdentity] 的长注释。
         */
        tokenStore.warmIdentity()
    }

    /** 主题偏好（跟随系统 / 浅色 / 深色）。冷启动要在 setContent 之前同步读，见 ThemePreference */
    val theme: ThemePreference = ThemePreference(appContext)

    val session: SessionRepository = SessionRepository(appContext, tokenStore)

    /**
     * 各域仓库都是无状态的（分页状态由页面的 PostList 持有），
     * 所以可以安全地全局共享一份。
     */
    val posts: PostRepository = PostRepository(session)
    /** 帖子详情页的评论（列表 / 发表 / 删除 / 点赞） */
    val comments: CommentRepository = CommentRepository(session)
    val books: BookRepository = BookRepository(session)
    val users: UserRepository = UserRepository(session)
    /**
     * 关注（他人主页的「关注 / 已关注」按钮）。
     *
     * 与 [UserRepository] 分开：那个管**公开资料**（`/users/:id`），这个管**关系**
     * （`/api/friends` 那几个端点）—— 两者端点、缓存语义、失败处理都不同
     * （查关注状态失败应当静默降级，而资料失败要显示错误），
     * 合成一个仓库会让"哪个失败该报错"变得说不清。
     *
     * 注意：KDoc 里**不要**写出「斜杠 + 星号」开头的路径 ——
     * Kotlin 的块注释支持嵌套，那会再开一层注释，一个没收好就把整个文件后半段吞掉。
     */
    val friends: FriendRepository = FriendRepository(session)
    val voice: VoiceRepository = VoiceRepository(session)

    /**
     * 语音房**活动会话持有者**（P0）：进房时登记、退房时注销；通知栏退出、
     * 登录态失效、前台服务失败都经它路由到当前会话的控制器。
     * 挂在依赖图里（而不是随手 object）是为了与其他单例同一套装配/兜底路径；
     * 进程默认实例由 KApp.onCreate 安装（见上），前台服务等无 Activity 的
     * 调用点经 VoiceRoomSessionHub.get() 访问。
     */
    val voiceHub: top.kuangdada.k.nativeapp.voice.VoiceRoomSessionHub =
        top.kuangdada.k.nativeapp.voice.VoiceRoomSessionHub()

    val messages: MessageRepository = MessageRepository(session)
    /** 实时事件流（SSE）：新私信 / 新通知 / 新公告，让各页面能"自己更新"而不是等用户下拉 */
    val realtime: RealtimeClient = RealtimeClient(session)

    /**
     * 公告 / 管理后台仓库。
     *
     * ⚠️ 声明位置**必须在 [inbox] 之前**：Kotlin 的类体初始化按声明顺序执行，
     * 而 `inbox` 的构造要把它传进去 —— 放在后面的话这里还是未初始化的 null，
     * 构造 `InboxStore` 时直接 NPE（`checkNotNullParameter`），
     * 表现为"点图标就闪退"且栈里看不出业务线索。
     */
    val admin: AdminRepository = AdminRepository(session)

    /**
     * 进程级作用域：所有"不该跟 Activity 一起死"的常驻工作都挂在这里
     * （收件箱轮询、SSE 连接、通知中心的事件收集）。
     *
     * 为什么用 `Main.immediate` 而不是 Default：这几个组件共享少量可变状态
     * （`InboxStore` 的定时器与单飞句柄、`RealtimeClient` 的 job/source），
     * 统一在主线程上读写就不需要给每一处都上锁；网络请求本身仍由 Retrofit/OkHttp
     * 切到 IO（`SessionRepository` 的仓库层都是 `withContext(Dispatchers.IO)`）。
     *
     * ⚠️ **必须带 [crashGuard]**：`launch` 里未捕获的异常会一路冒到线程的
     * 未捕获异常处理器 —— 也就是**崩掉整个 App**。这个作用域里跑的是轮询、事件收集
     * 这类"后台杂活"，任何一处没想到的异常都不该让用户丢掉整个界面（尤其在后台崩，
     * 用户看到的是"打开就闪退"，栈里还全是协程框架）。仓库层的 `call {}` 已经把
     * 网络异常都转成了 `ApiResult.Failure`，这里是最后一道兜底。
     */
    val appScope: CoroutineScope = CoroutineScope(
        SupervisorJob() + Dispatchers.Main.immediate +
            CoroutineExceptionHandler { _, e ->
                Log.e(TAG, "进程级协程未捕获异常（已吞掉，避免崩进程）", e)
            }
    )

    /** 「App 在不在前台」：通知中心用它在进程级判断（取代原来 Compose 里的那个状态） */
    val foreground: AppForeground = AppForeground()

    /** 通知偏好（目前只有「是否问过通知权限」一个标记） */
    val notifyPref: NotifyPreference = NotifyPreference(appContext)

    /**
     * 收件箱（会话 / 通知 / 公告 / 未读角标）的**唯一**来源。
     *
     * 用户反馈「在 App 里消息页也没有角标，一定要点进消息页才看到消息来了」的根因就是
     * 它此前不存在：角标只有"SSE 事件到达"与"进过消息页"两个来源，
     * 冷启动必然是 0、漏掉的事件也补不回来（服务端没有离线补偿）。
     * 详见 [InboxStore] 的类注释。
     */
    val inbox: InboxStore = InboxStore(messages, admin, session, realtime, appScope)

    /** 事件 → 系统通知（进程级）。取代了原来写在 `AppShell` 里的那段收集逻辑 */
    val notificationCenter: SocialNotificationCenter = SocialNotificationCenter(
        context = appContext,
        session = session,
        inbox = inbox,
        source = realtime,
        foreground = foreground,
    )

    /**
     * SSE 连接 / 收件箱对账 / 诊断上报的进程级联动（S1 多窗口起，2026-10-10）。
     *
     * 从 `AppShell` 的生命周期观察者搬来 —— 多窗口后"前台"必须按**进程**判定
     * （宿主窗口 start 与主窗口 stop 同帧），条件 = `foreground && 已登录`。
     * 由 `KApp.onCreate` 调 [ForegroundRealtime.install] 启动订阅。详见其类注释。
     */
    val foregroundRealtime: ForegroundRealtime = ForegroundRealtime(
        context = appContext,
        realtime = realtime,
        inbox = inbox,
        session = session,
        foreground = foreground,
        scope = appScope,
    )

    /**
     * 发帖 / 编辑仓库。
     *
     * 这里把 [PostRepository.bumpContentVersion] 接进它的成功回调：**发布/编辑成功后，
     * 所有缓存了帖子列表的页面都要知道"内容变了"**，否则从发布页回到主页看到的还是旧列表
     * （用户实测反馈"要重启 App 才刷新"）。装配点放在这里，是因为两个仓库互相引用会绕成环。
     */
    val composer: ComposerRepository = ComposerRepository(appContext, session) { posts.bumpContentVersion() }

    companion object {
        private const val TAG = "KApp"

        /**
         * 取依赖图，**取不到就自建**。
         *
         * 为什么要有这条兜底：`android:name=".KApp"` 漏配时的表现是启动即崩
         * （`ClassCastException: android.app.Application cannot be cast to ...KApp`），
         * 而这个崩溃发生在 UI 起来之前 —— 用户看到的是"点了图标就闪退"，日志里
         * 也没有业务线索。改成自建 + 显式警告后：功能可用，问题在日志里一眼可见。
         */
        fun from(context: Context): AppGraph {
            val app = context.applicationContext
            if (app is KApp) return app.graph
            Log.w(
                TAG,
                "AndroidManifest 里没有注册 android:name=\".KApp\"，已临时自建依赖图。" +
                    "请补上该属性 —— 否则每次拿到的都是新实例（登录态/仓库缓存不会共享）。"
            )
            return AppGraph(app)
        }
    }
}
