package top.kuangdada.k.nativeapp.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import top.kuangdada.k.core.data.model.BookChapter
import top.kuangdada.k.core.data.model.BookDetail

/**
 * ============================================================
 * 导航（AppDestination + AppNavigator）
 * ============================================================
 * **为什么不引 Navigation Compose**：navigation-compose 2.8+ 默认走类型安全路由
 * （需要 kotlinx-serialization 的 `@Serializable` + Navigation 的 kotlin 插件），
 * 而本项目的导航层级很浅（一级 tab → 二级详情 → 三级阅读器），
 * 引入它的收益（深层图、多返回栈、deep link 解析）还不成立。
 * 用一个自持返回栈的轻量导航器即可，等出现"每个 tab 各自独立返回栈"的需求再换。
 *
 * **设计稿 §3.3 的两条要求已经落在路由表上**（而不是靠路径正则散判 —— 那正是文档指出的
 * 旧实现缺陷，容易漏）：
 *  · [AppDestination.navKey]：这个页面到底高亮哪个一级 tab；
 *  · [AppDestination.immersive]：这个页面要不要隐藏底部导航。
 */
sealed interface AppDestination {

    /** 高亮哪个一级 tab（对应导航胶囊的 key；null = 不显示导航） */
    val navKey: String?

    /** 是否沉浸（隐藏底部导航）。设计稿：图书详情 / 阅读器 / 语音房内 / 发布弹层 都是沉浸态 */
    val immersive: Boolean

    // ---- 一级页（显示导航胶囊） ----

    /** 首页信息流 · 高亮首页 */
    data object Home : AppDestination {
        override val navKey = Tab.Home.key
        override val immersive = false
    }

    /**
     * 搜索发现 · 高亮首页（设计稿映射表：搜索发现按首页高亮）
     *
     * `tag` 非空 = 带着话题进来（点正文里的 #话题 跳过来），页面直接出该话题的结果。
     * 之所以做成路由参数而不是进程内缓存：从帖子点话题进搜索是**可序列化**的一次导航，
     * 进程被回收后恢复也应该还是那个话题的结果页。
     */
    data class Explore(val tag: String? = null) : AppDestination {
        override val navKey = Tab.Home.key
        override val immersive = false
    }

    /** 图书列表 · 高亮图书 */
    data object Books : AppDestination {
        override val navKey = Tab.Books.key
        override val immersive = false
    }

    /** 语音 · 房间列表 · 高亮语音 */
    data object Voice : AppDestination {
        override val navKey = Tab.Voice.key
        override val immersive = false
    }

    /** 消息 · 高亮消息（会话列表在 M3） */
    data object Messages : AppDestination {
        override val navKey = Tab.Messages.key
        override val immersive = false
    }

    /** 个人主页 · 高亮主页 */
    data object Profile : AppDestination {
        override val navKey = Tab.Profile.key
        override val immersive = false
    }

    /**
     * 登录弹层 · **覆盖态**（设计稿 §3.3.1 映射表：登录弹层「背后仍显示导航，被遮罩压暗」）。
     *
     * 实现要点：它是一个压栈目标，但**不替换**底下的页面 —— AppShell 会用 [AppNavigator.previous]
     * 把下面那页照常渲染出来，再把弹层浮在它上面（含导航胶囊一起被遮罩压暗）。
     * 做成压栈目标而不是 App 级布尔状态，是为了让「返回键关闭」与「令牌失效自动弹出」
     * （MainActivity 观察 AuthState.Expired）都走既有机制，不必各写一套。
     */
    data object Login : AppDestination {
        override val navKey = null
        // 非沉浸：胶囊要留在背景里被遮罩压暗（沉浸会让它整块消失，与设计不符）
        override val immersive = false
    }

    // ---- 二级 / 三级页（沉浸） ----

    /** 图书详情 · 沉浸（设计稿映射表：图书详情不显示导航） */
    data class BookDetailDest(val bookId: String) : AppDestination {
        override val navKey = null
        override val immersive = true
    }

    /** 阅读器 · 沉浸 */
    data class ReaderDest(val bookId: String, val chapterFile: String) : AppDestination {
        override val navKey = null
        override val immersive = true
    }

    /**
     * 聊天 · 沉浸（设计稿映射表：三级页面隐藏导航）
     *
     * 用 partnerId / partnerName / partnerAvatar 三个**基本类型**参数而不是传整个会话对象
     * —— 导航状态要能被 [encodeDest] 序列化（进程回收后恢复），对象塞不进去。
     */
    data class ChatDest(
        val partnerId: Long,
        val partnerName: String?,
        /**
         * 对方头像（**已解析成绝对地址**）。
         *
         * 为什么要把头像塞进导航状态：消息接口（`MessageDto`）里**没有**头像字段，
         * 只有 `sender_username`；不在进来时带上，聊天页就只能显示默认人像。
         * 会话列表里本来就有这个 URL，顺手传下去比在聊天页再查一次便宜得多。
         * 深链（`DeepLink`）进聊天时拿不到头像，给 null 即可，UI 会退化成默认头像。
         */
        val partnerAvatar: String? = null,
    ) : AppDestination {
        override val navKey = null
        override val immersive = true
    }

    /**
     * 帖子详情 · 沉浸（设计稿映射表：二级页隐藏导航）
     *
     * 只带 `postId`：导航状态要可序列化（[encodeDest]），帖子对象塞不进去。
     * 详情页优先用列表里已有的缓存对象（首帧不空白），缓存没有（深链/进程回收）再拉接口。
     */
    data class PostDetailDest(val postId: Long) : AppDestination {
        override val navKey = null
        override val immersive = true
    }

    /**
     * 他人主页 · 沉浸（设计稿「他人资料页」：二级页，顶栏自带返回，不显示导航胶囊）。
     *
     * **为什么不是 [Profile] 加参数**：[Profile] 是**一级 tab**（`navKey = 主页`，
     * 底部的胶囊会高亮它、切 tab 走淡入）；他人主页是**从卡片/详情页推上来的二级页**
     * （滑动进场、返回回到"进来的那一页"）。两者的导航语义完全不同 ——
     * 合并成一个目的地会让"返回"在 tab 切换与二级返回之间二义。
     *
     * 只带 `userId`：导航状态要可序列化（[encodeDest]），资料对象塞不进去；
     * 页面优先用仓库缓存里的资料（首帧就有头像/昵称），缓存没有再拉 `/users/:id`。
     */
    data class UserProfileDest(val userId: Long) : AppDestination {
        override val navKey = null
        override val immersive = true
    }

    /**
     * 视频播放 · 沉浸
     *
     * 只带 `postId`：视频地址从帖子缓存里取（导航状态要可序列化，URL 里带 `:` `/` 不适合塞进去）。
     * 缓存丢了（进程回收/深链）就当作没有可播的视频，直接退回上一页。
     */
    data class VideoDest(val postId: Long) : AppDestination {
        override val navKey = null
        override val immersive = true
    }

    /**
     * 发布 / 编辑弹层 · 全屏 sheet · 沉浸（设计稿：发布弹层不显示导航）
     *
     * `editingPostId` 为 null = 新建；非 null = 编辑该帖（走 `PUT /api/posts/:id`）。
     * 编辑时只带 id，帖子的正文与既有图片由进程内缓存提供（导航状态要可序列化）。
     */
    data class ComposerDest(val editingPostId: Long? = null) : AppDestination {
        override val navKey = null
        override val immersive = true
    }

    /**
     * 管理后台 · 沉浸（设计稿映射表：管理后台按**主页**高亮；
     * 但它是从主页二级菜单进入的，这里做成沉浸更符合"二级页面"的层级感）。
     */
    data object Admin : AppDestination {
        override val navKey = null
        override val immersive = true
    }

    /**
     * 新建公告 · 沉浸（设计稿「新建公告」：全屏表单 + 底部「发布」）。
     *
     * 无参数：标题/内容/发送范围都是页面自己的临时状态，发布成功后直接 pop 回管理后台
     * （服务端没有"编辑公告"，所以也没有"带着某条公告进来改"这种用法）。
     */
    data object NewAnnouncement : AppDestination {
        override val navKey = null
        override val immersive = true
    }

    /**
     * 编辑资料 · 沉浸（设计稿「编辑资料」：全屏表单，底部只有「保存」，没有导航胶囊）。
     *
     * 无参数 —— 昵称/简介/邮箱全部来自会话里的登录用户（[SessionRepository.state]），
     * 不需要（也不该）把用户对象塞进导航状态（导航状态要能被 [encodeDest] 序列化）。
     */
    data object ProfileEdit : AppDestination {
        override val navKey = null
        override val immersive = true
    }

    /** 公告 · 设计稿映射表：公告按**消息**高亮 */
    data object Announcements : AppDestination {
        override val navKey = Tab.Messages.key
        override val immersive = false
    }

    /**
     * 语音房内 · **沉浸**（设计稿映射表：语音房内不显示导航）
     *
     * 只用 roomId 传参（房间名等信息由房间列表页放进进程内缓存），
     * 这样导航状态可序列化、进程回收后也能恢复。
     */
    data class VoiceRoomDest(val roomId: Long) : AppDestination {
        override val navKey = null
        override val immersive = true
    }
}

/**
 * 最近一次导航操作的类型 —— 页面转场靠它判断方向（M1 新增）。
 *
 * **为什么必须是显式记录，而不是"比较两页的层级"推断**：`resetTo` / `switchTab` /
 * `backToPrevious`（它会先摘掉"已经死掉的中间页"）都会让"层级更大就是进、更小就是退"
 * 这条推断出错，而推断错的表现是**转场方向反了**（返回时页面往右滑出去），
 * 属于一眼可见的观感 bug。所以谁改的 `current` 谁负责记录怎么改的。
 */
enum class NavOp {
    /** 压栈进入下级页：新页从右侧（或下方）进 */
    Push,

    /** 返回上一级：与 [Push] 反向 */
    Pop,

    /** 切一级 tab：同级跳转，不做左右滑动 */
    Tab,

    /** 重置（`resetTo` / `replace`，含深链与"回首页"兜底）：按淡入处理 */
    Reset,
}

/**
 * 轻量导航器：一层返回栈 + 一级 tab 记忆。
 *
 * 一级 tab 之间切换**不压栈**（切 tab 是同级跳转，不该让返回键回退一串 tab）；
 * 进入二级/三级页压栈，返回键逐层弹出。
 */
class AppNavigator(initial: AppDestination) {

    var current by mutableStateOf(initial)
        private set

    /**
     * 返回栈条目：**页面 + 它的实例号**（实例号的用途见 [currentSeq]）。
     */
    private class Entry(val dest: AppDestination, val seq: Long)

    private val backStack = ArrayDeque<Entry>()

    /**
     * 当前页的**实例号**：二级/三级页每次压栈都拿一个新号，一级 tab 恒为 0。
     *
     * 解决的真机 bug（用户实测）：**同一个帖子进出两次，第二次进来滚动位置还在下方**
     * —— 底部内容顶到顶栏之上，页面看起来"没在顶部"。
     *
     * 根因是 AppShell 的 `rememberSaveableStateHolder` 按**目的地**存 `rememberSaveable`
     * 状态（`rememberLazyListState()` 正是这一类）：`post:123` 这个 key 在页面**出栈后**
     * 仍然留着上一轮的滚动位置，下次进来就被恢复。而在用户语义里"出栈"就是这一页没了，
     * 再进来应该是全新的一次访问。
     *
     * 于是把"目的地"和"这一次访问"分开 —— 状态 key 里带上实例号（见 [destStateKey]）：
     *  · 出栈后再进 → 新号 → 新 key → 状态为空 → 列表自然在顶部 ✔
     *  · 详情页压着一个作者主页、返回详情 → 恢复原号 → 原 key → 滚动位置保留 ✔
     *    （"被压住"和"已经关掉"是两回事，前者必须记住）
     *  · 一级 tab 恒为 0 → 切 tab 再回来仍记住列表位置（既有行为，不能丢）✔
     */
    var currentSeq by mutableStateOf(0L)
        private set

    /** 实例号发号器。0 留给"稳定页"（一级 tab），所以从 1 开始 */
    private var nextSeq = 1L

    /** 当前所在的一级 tab（切到二级页后仍然记住，用于"返回时回到哪个 tab"） */
    var activeTabKey: String = initial.navKey ?: Tab.Home.key
        private set

    /**
     * 最近一次导航操作（M1 新增）。
     *
     * 页面转场读它决定方向；转场结束后**不重置** —— 它是"上一步干了什么"的历史，
     * 而不是"现在正在干什么"的状态。初值 [NavOp.Reset]：冷启动/进程回收恢复后
     * 第一次进入页面按淡入处理，不做左右滑动（本来就没有"从哪来"）。
     */
    var lastOp by mutableStateOf(NavOp.Reset)
        private set

    /**
     * 当前页的层级（M1 新增）：一级页 = 1，每压一层 +1。
     *
     * 给转场**分档**用（例如二级页滑入幅度大、三级页更小），也让页面能知道自己有多深。
     * 它恒等于「返回栈里剩下的页数 + 1」（当前页自己也算一层）。
     */
    var depth by mutableIntStateOf(1)
        private set

    val canGoBack: Boolean get() = backStack.isNotEmpty()

    /**
     * 返回栈顶 = **当前页下面那一页**。
     *
     * 给「覆盖态」用：登录弹层是浮在现有页面之上的浮层（不是整页），
     * 所以渲染时要知道底下该画哪个页面。栈空时返回 null（调用方回落到首页）。
     */
    val previous: AppDestination? get() = backStack.lastOrNull()?.dest

    /**
     * 返回栈顶条目的实例号（配合 [previous] 用），栈空时 null。
     *
     * 覆盖态（登录弹层）要用它：登录压栈时底下那页照常渲染，它的状态 key 必须取
     * **栈顶条目**的实例号，而不是登录页自己的 —— 否则"在详情页点登录"会把底下这个
     * 详情页当成新实例重建（滚动位置丢掉）。
     */
    val previousSeq: Long? get() = backStack.lastOrNull()?.seq

    /**
     * 当前仍然"活着"的页面 key（当前页 + 被压在返回栈里的页）。
     *
     * 给 AppShell 清 `SaveableStateHolder` 用：不在这个集合里的 key 都是已经出栈的页面，
     * 状态没有恢复的机会，留着只是随访问次数线性占内存（见 [currentSeq]）。
     */
    fun aliveStateKeys(): Set<String> {
        val keys = HashSet<String>(backStack.size + 1)
        keys += destStateKey(current, currentSeq)
        for (entry in backStack) keys += destStateKey(entry.dest, entry.seq)
        return keys
    }

    /** 切一级 tab：清空二级栈（同级跳转） */
    fun switchTab(destination: AppDestination) {
        backStack.clear()
        activeTabKey = destination.navKey ?: activeTabKey
        current = destination
        // 一级 tab 用稳定实例号：切走再回来仍恢复列表位置（见 currentSeq 的注释）
        currentSeq = 0L
        lastOp = NavOp.Tab
        depth = 1
    }

    /** 进入下级页面并压栈 */
    fun push(destination: AppDestination) {
        backStack.addLast(Entry(current, currentSeq))
        current = destination
        // 新的一次访问 = 新实例号（修「再次进入详情页滚动位置还在下方」）
        currentSeq = nextSeq++
        lastOp = NavOp.Push
        depth = backStack.size + 1
    }

    /** 返回上一级；返回 false 表示栈空（调用方决定是否最小化 App） */
    fun pop(): Boolean {
        val previous = backStack.removeLastOrNull() ?: return false
        current = previous.dest
        // 恢复到被压住时的实例号 —— 返回详情页时滚动位置还在原处
        currentSeq = previous.seq
        lastOp = NavOp.Pop
        depth = backStack.size + 1
        return true
    }

    /**
     * 就地替换当前页（不压栈、不动返回栈）。
     *
     * 转场按 [NavOp.Reset]（淡入）处理：语义上它既不是"进"也不是"退"，
     * 用左右滑动会误导用户以为层级变了。层级 [depth] 保持不变。
     *
     * 实例号取新的：替换后是另一个页面，不该继承被替换那页的状态。
     */
    fun replace(destination: AppDestination) {
        current = destination
        currentSeq = nextSeq++
        lastOp = NavOp.Reset
    }

    /** 回到底部导航的某个 tab（详情页顶部"返回首页"之类用） */
    fun resetTo(destination: AppDestination) {
        backStack.clear()
        activeTabKey = destination.navKey ?: activeTabKey
        current = destination
        currentSeq = 0L
        lastOp = NavOp.Reset
        depth = 1
    }

    /**
     * 把返回栈里满足 [predicate] 的**中间页**摘掉（当前页不变）。
     *
     * 用途：某个页面所指的东西已经不存在了（帖子被删了），别让它留在栈里 ——
     * 否则返回时正好回到那个**已经死掉的页面**（界面上是「帖子加载失败 HTTP 404」）。
     *
     * **刻意不动 [lastOp]**：这个方法只清理栈、不改 `current`，真正的页面切换由随后的
     * [pop] 完成 —— 转场方向应该由那一步决定（`backToPrevious` 就是"先摘死页面、再 pop"）。
     *
     * @return 摘掉了几项
     */
    fun dropFromStack(predicate: (AppDestination) -> Boolean): Int {
        val kept = backStack.filterNot { predicate(it.dest) }
        val removed = backStack.size - kept.size
        if (removed == 0) return 0
        backStack.clear()
        backStack.addAll(kept)
        // 栈浅了，层级要跟着回落（否则转场分档会按旧的深度取档）
        depth = backStack.size + 1
        return removed
    }

    /**
     * 退出当前二级页，回到**进来时那一页**。
     *
     * 这就是"从哪里进就退到那个页面"的实现：`pop()` 本来就是回到栈里下一页，
     * 也就是用户进来的地方 —— 问题从来不在 pop，而在**有些地方用了 `resetTo`**，
     * 那会把整条返回栈清掉、把人硬送回首页（用户实测反馈：
     * 「点击通知的评论跳转到帖子，返回的时候在消息对话区，应该是从哪里进就退出到那个页面」）。
     *
     * @param dropDeadPages 先把这些页面摘掉（例如"已经被删掉的那条帖子详情页"）：
     *   摘掉之后 pop 才不会落在死页面上。
     * @return false = 栈已空（例如从深链直接进详情页），调用方自行决定兜底去向
     */
    fun backToPrevious(dropDeadPages: (AppDestination) -> Boolean = { false }): Boolean {
        dropFromStack(dropDeadPages)
        return pop()
    }
}

/** 让导航器在配置变更（旋转/深色切换）后存活 —— 本工程的 Activity 声明了 configChanges，
 *  所以实际很少重建；这里用 rememberSaveable + Saver 兜住进程被回收的情况。 */
@Composable
fun rememberAppNavigator(initial: AppDestination = AppDestination.Home): AppNavigator {
    val saver = remember {
        Saver<AppNavigator, String>(
            save = { it.current.let(::encodeDest) },
            restore = { AppNavigator(decodeDest(it)) },
        )
    }
    return rememberSaveable(saver = saver) { AppNavigator(initial) }
}

/**
 * `rememberSaveable` 状态的 key = 目的地 + **实例号**（见 [AppNavigator.currentSeq]）。
 *
 * 实例号 0 表示"稳定页"：一级 tab 用的还是老的裸 key（老状态照样能恢复，
 * 这次改动不会让 tab 页丢记忆）；二级/三级页每次压栈换一个新号，
 * 于是"出栈后再进"读不到上一轮的状态 —— 列表回到顶部。
 */
internal fun destStateKey(dest: AppDestination, seq: Long): String =
    if (seq <= 0L) encodeDest(dest) else encodeDest(dest) + "#" + seq

/** 极简序列化：只保当前页（返回栈丢了可接受，比整页状态丢失好） */
internal fun encodeDest(dest: AppDestination): String = when (dest) {
    is AppDestination.Home -> "home"
    is AppDestination.Explore -> if (dest.tag.isNullOrBlank()) {
        "explore"
    } else {
        // 话题里可能有中文/空格/斜杠，必须转义后再拼进这一串
        "explore:" + java.net.URLEncoder.encode(dest.tag, "UTF-8")
    }
    is AppDestination.Books -> "books"
    is AppDestination.Voice -> "voice"
    is AppDestination.Messages -> "messages"
    is AppDestination.Profile -> "profile"
    is AppDestination.Login -> "login"
    is AppDestination.ComposerDest -> "composer:${dest.editingPostId ?: ""}"
    is AppDestination.Admin -> "admin"
    is AppDestination.NewAnnouncement -> "new-announcement"
    is AppDestination.ProfileEdit -> "profile-edit"
    is AppDestination.Announcements -> "announcements"
    is AppDestination.VoiceRoomDest -> "voice:${dest.roomId}"
    is AppDestination.BookDetailDest -> "book:${dest.bookId}"
    is AppDestination.ReaderDest -> "read:${dest.bookId}:${dest.chapterFile}"
    is AppDestination.ChatDest -> "chat:${dest.partnerId}:${dest.partnerName ?: ""}"
    is AppDestination.PostDetailDest -> "post:${dest.postId}"
    is AppDestination.UserProfileDest -> "user:${dest.userId}"
    is AppDestination.VideoDest -> "video:${dest.postId}"
}

internal fun decodeDest(raw: String): AppDestination = when {
    raw == "home" -> AppDestination.Home
    raw == "explore" -> AppDestination.Explore()
    raw.startsWith("explore:") -> {
        val tag = runCatching {
            java.net.URLDecoder.decode(raw.removePrefix("explore:"), "UTF-8")
        }.getOrNull()
        AppDestination.Explore(tag = tag?.takeIf { it.isNotBlank() })
    }
    raw == "books" -> AppDestination.Books
    raw == "voice" -> AppDestination.Voice
    raw == "messages" -> AppDestination.Messages
    raw == "profile" -> AppDestination.Profile
    raw == "login" -> AppDestination.Login
    raw == "composer" -> AppDestination.ComposerDest()
    raw.startsWith("composer:") -> {
        val id = raw.removePrefix("composer:").toLongOrNull()
        AppDestination.ComposerDest(editingPostId = id)
    }
    raw == "admin" -> AppDestination.Admin
    raw == "new-announcement" -> AppDestination.NewAnnouncement
    raw == "profile-edit" -> AppDestination.ProfileEdit
    raw == "announcements" -> AppDestination.Announcements
    raw.startsWith("voice:") -> {
        val id = raw.removePrefix("voice:").toLongOrNull()
        if (id == null) AppDestination.Voice else AppDestination.VoiceRoomDest(id)
    }
    raw.startsWith("book:") -> AppDestination.BookDetailDest(raw.removePrefix("book:"))
    raw.startsWith("read:") -> {
        val rest = raw.removePrefix("read:")
        val idx = rest.lastIndexOf(':')
        if (idx <= 0) AppDestination.Books
        else AppDestination.ReaderDest(rest.substring(0, idx), rest.substring(idx + 1))
    }
    raw.startsWith("chat:") -> {
        val rest = raw.removePrefix("chat:")
        val idx = rest.indexOf(':')
        if (idx <= 0) AppDestination.Messages
        else {
            val id = rest.substring(0, idx).toLongOrNull()
            if (id == null) AppDestination.Messages
            else AppDestination.ChatDest(id, rest.substring(idx + 1).ifBlank { null })
        }
    }
    raw.startsWith("post:") -> {
        val id = raw.removePrefix("post:").toLongOrNull()
        if (id == null) AppDestination.Home else AppDestination.PostDetailDest(id)
    }
    // 他人主页。`user:` 这个前缀**刻意不与 DeepLink 的 `user:` 冲突** ——
    // 深链只认 `voice:` / `book:` / `chat:` 三种编码形态（见 DeepLink.parseEncoded）。
    raw.startsWith("user:") -> {
        val id = raw.removePrefix("user:").toLongOrNull()
        if (id == null) AppDestination.Home else AppDestination.UserProfileDest(id)
    }
    raw.startsWith("video:") -> {
        val id = raw.removePrefix("video:").toLongOrNull()
        if (id == null) AppDestination.Home else AppDestination.VideoDest(id)
    }
    else -> AppDestination.Home
}

/** 供 UI 侧构造阅读器目标用（避免把 BookDetail/Chapter 两个类型漏到导航层签名里） */
fun readerDestination(detail: BookDetail, chapter: BookChapter): AppDestination =
    AppDestination.ReaderDest(detail.id, chapter.file)
