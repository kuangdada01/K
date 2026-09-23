package top.kuangdada.k.nativeapp

import android.app.Application
import android.content.Context
import android.util.Log
import coil3.ImageLoader
import coil3.PlatformContext
import coil3.SingletonImageLoader
import top.kuangdada.k.core.data.AdminRepository
import top.kuangdada.k.core.data.BookRepository
import top.kuangdada.k.core.data.ComposerRepository
import top.kuangdada.k.core.data.CommentRepository
import top.kuangdada.k.core.data.FriendRepository
import top.kuangdada.k.core.data.MessageRepository
import top.kuangdada.k.core.data.PostRepository
import top.kuangdada.k.core.data.RealtimeClient
import top.kuangdada.k.core.data.SessionRepository
import top.kuangdada.k.core.data.ThemePreference
import top.kuangdada.k.core.data.TokenStore
import top.kuangdada.k.core.data.UserRepository
import top.kuangdada.k.core.data.VoiceRepository
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
        super.onCreate()
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
     */
    override fun newImageLoader(context: PlatformContext): ImageLoader =
        ImageLoader.Builder(context)
            .fetcherCoroutineContext(ImageLoading.gated)
            .decoderCoroutineContext(ImageLoading.gated)
            .build()
}

/** 进程级依赖图（单例式：一个进程一份） */
class AppGraph(app: Context) {

    private val appContext = app.applicationContext

    val tokenStore: TokenStore = TokenStore(appContext)

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
    val voice: VoiceRepository = VoiceRepository(session, appContext)
    val messages: MessageRepository = MessageRepository(session)
    /** 实时事件流（SSE）：新私信 / 新通知 / 新公告，让各页面能"自己更新"而不是等用户下拉 */
    val realtime: RealtimeClient = RealtimeClient(session)
    /**
     * 发帖 / 编辑仓库。
     *
     * 这里把 [PostRepository.bumpContentVersion] 接进它的成功回调：**发布/编辑成功后，
     * 所有缓存了帖子列表的页面都要知道"内容变了"**，否则从发布页回到主页看到的还是旧列表
     * （用户实测反馈"要重启 App 才刷新"）。装配点放在这里，是因为两个仓库互相引用会绕成环。
     */
    val composer: ComposerRepository = ComposerRepository(session) { posts.bumpContentVersion() }
    val admin: AdminRepository = AdminRepository(session)

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
