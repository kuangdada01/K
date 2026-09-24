package top.kuangdada.k.nativeapp.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import top.kuangdada.k.core.data.ApiResult
import top.kuangdada.k.core.data.VoiceRepository
import top.kuangdada.k.core.data.canJoinVoiceRoom
import top.kuangdada.k.core.data.displayMessage
import top.kuangdada.k.core.data.image.ImageCompressor
import top.kuangdada.k.core.data.model.VOICE_MAX_ROOM_SIZE
import top.kuangdada.k.core.data.model.VoiceRoom
import top.kuangdada.k.core.designsystem.component.KButton
import top.kuangdada.k.core.designsystem.component.KButtonVariant
import top.kuangdada.k.core.designsystem.component.KPlaceholder
import top.kuangdada.k.core.designsystem.component.KPlaceholderKind
import top.kuangdada.k.core.designsystem.component.KTextField
import top.kuangdada.k.core.designsystem.theme.KMotion
import top.kuangdada.k.core.designsystem.theme.KDimens
import top.kuangdada.k.core.designsystem.theme.KRadius
import top.kuangdada.k.core.designsystem.theme.KSpacing
import top.kuangdada.k.core.designsystem.theme.KTheme
import top.kuangdada.k.core.designsystem.theme.KType

/**
 * ============================================================
 * 语音 · 房间列表（设计稿 §3.3.1；设计稿原稿漏了这一屏，只画了房内沉浸态）
 * ============================================================
 * 设计稿要点：
 *  · 页头「语音 + 新建房间」；
 *  · 房间用**大卡 + 宽封面**（`fill_container × 108px`）而非列表行，一屏 4 张自然铺满，
 *    滚动内容正好穿到悬浮胶囊底下；
 *  · **进行中的房间**（有人在）副标题用 `--accent` 与空房间区分。
 *
 * 本阶段范围：列表 + 建房 + 删除自己创建的房间。**房内的 WebRTC / 信令 / 录制属 M3**
 * —— 那部分是全项目最复杂的子系统（19 个信令事件 + 音频图 + 屏幕共享），不掺进来。
 */
@Composable
fun VoiceRoomsScreen(
    voice: VoiceRepository,
    isLoggedIn: Boolean,
    onOpenRoom: (VoiceRoom) -> Unit,
) {
    val c = KTheme.colors
    val scope = rememberCoroutineScope()

    // 先用仓库缓存直接渲染（切走再回来不空白、不转圈），再静默刷新
    var rooms by remember { mutableStateOf(voice.cachedRooms) }
    var loading by remember { mutableStateOf(rooms.isEmpty()) }
    var error by remember { mutableStateOf<String?>(null) }
    var creating by remember { mutableStateOf(false) }
    var newName by remember { mutableStateOf("") }
    var newDesc by remember { mutableStateOf("") }
    // 建房封面：选图（系统 Photo Picker）→ 客户端压缩拷贝 → 立即上传拿 URL；创建时随请求带回
    var coverLocal by remember { mutableStateOf<PickedImage?>(null) }
    var coverUrl by remember { mutableStateOf<String?>(null) }
    var uploadingCover by remember { mutableStateOf(false) }
    var toast by remember { mutableStateOf<String?>(null) }
    val context = LocalContext.current
    // 创建按钮 + → × 的旋转过渡：展开时图标转半圈并切换字形（× 与 + 都是 180° 对称，
    // 转完的静止形态不变，只有过程在转 —— 弹簧让连续点击有跟手的方向感）
    val createIconRotation by animateFloatAsState(
        targetValue = if (creating) 45f else 0f,
        animationSpec = KMotion.spatial(),
        label = "createToggleRotation",
    )

    /**
     * 收起建房表单 = **取消**：草稿（名称/简介/已上传的封面）一并清掉，
     * 重新展开是空表单 —— 只收起不清内容的话，用户会以为内容删不掉（必须重启 App）。
     */
    fun cancelCreate() {
        creating = false
        newName = ""
        newDesc = ""
        coverLocal = null
        coverUrl = null
    }
    val pickCover = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia()
    ) { uri ->
        if (uri == null || uploadingCover) return@rememberLauncherForActivityResult
        scope.launch {
            uploadingCover = true
            toast = null
            // 压缩与拷贝都在 IO 上（Photo Picker 的读权限是临时的，先落 cacheDir）
            val picked: PickedImage? = withContext(Dispatchers.IO) {
                // 客户端先压（长边受限 + 统一 jpg）：上传体积小，服务端展示高度只有 108dp
                val compressed = ImageCompressor.compressToFile(context, uri, purpose = "cover")
                if (compressed != null) {
                    PickedImage(compressed, "image/jpeg")
                } else {
                    // GIF/小图/压缩失败 → 回退原图，扩展名与 MIME 一起带过去
                    copyPickedImageToCache(context, uri, prefix = "cover")
                }
            }
            if (picked == null) {
                uploadingCover = false
                toast = "读取图片失败，请换一张试试"
                return@launch
            }
            coverLocal = picked
            when (val r = voice.uploadRoomCover(picked.file, picked.mimeType)) {
                is ApiResult.Success -> coverUrl = r.data
                is ApiResult.Failure -> {
                    coverLocal = null
                    toast = r.error.displayMessage
                }
            }
            uploadingCover = false
        }
    }

    suspend fun load(silent: Boolean = false) {
        if (!silent) loading = true
        error = null
        when (val r = voice.rooms()) {
            is ApiResult.Success -> rooms = r.data
            is ApiResult.Failure -> error = r.error.displayMessage
        }
        loading = false
    }

    LaunchedEffect(Unit) { load(silent = rooms.isNotEmpty()) }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(c.bgPage)
            // 建房表单展开时，点表单以外的任何空白处都收起表单（+ 号同步变 ×）。
            // 子级的可点击元素（房间卡/表单控件）会自己消费点击，不会落到这里。
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
            ) { if (creating) cancelCreate() },
    ) {
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(
                start = KSpacing.md,
                end = KSpacing.md,
                // 这里**不能**有 top：页头那一项自己挂 kTopBar（见 KWidgets.kTopBar）。
                // 原来这档 16dp 叠在页头的 statusBarsPadding 上，本页顶栏被压到状态栏下 24dp。
                bottom = KDimens.navScrollPadding + KSpacing.lg,
            ),
            verticalArrangement = Arrangement.spacedBy(KSpacing.sm),
        ) {
            item {
                Column(
                    // 顶栏垂直位置的唯一来源（状态栏安全区 + KSpacing.xs）
                    modifier = Modifier.kTopBar(),
                    verticalArrangement = Arrangement.spacedBy(KSpacing.sm),
                ) {
                    // 页头：标题 + 右上角「+」实心圆钮（设计稿形态；点开建房表单）
                    KPageHeader(
                        title = "语音",
                        trailing = {
                            Box(
                                modifier = Modifier
                                    .size(KDimens.iconButton)
                                    .clip(CircleShape)
                                    .background(c.accent)
                                    .clickable { if (creating) cancelCreate() else creating = true },
                                contentAlignment = Alignment.Center,
                            ) {
                                // 展开建房表单时图标变 ×：明确表达"再点一下就是收起"
                                Glyph(
                                    tint = c.onAccent,
                                    kind = GlyphKind.Plus,
                                    size = KDimens.navIcon,
                                    modifier = Modifier.rotate(createIconRotation),
                                )
                            }
                        },
                    )

                    if (creating) {
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(KRadius.card))
                                .background(c.surface)
                                // 表单内部自己消费点击：点表单空白处不会触发外层的"收起"
                                .clickable(
                                    interactionSource = remember { MutableInteractionSource() },
                                    indication = null,
                                ) { }
                                .padding(KSpacing.md),
                            verticalArrangement = Arrangement.spacedBy(KSpacing.xs),
                        ) {
                            KTextField(
                                value = newName,
                                onValueChange = { newName = it },
                                placeholder = "房间名（必填）",
                            )
                            KTextField(
                                value = newDesc,
                                onValueChange = { newDesc = it },
                                placeholder = "房间简介（可选）",
                            )
                            // 封面入口：点横幅选图（系统 Photo Picker），选完即压缩上传并就地预览
                            Box(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .height(108.dp)
                                    .clip(RoundedCornerShape(KRadius.row))
                                    .background(c.surfaceSunken)
                                    .clickable {
                                        if (!uploadingCover) {
                                            pickCover.launch(
                                                PickVisualMediaRequest(
                                                    ActivityResultContracts.PickVisualMedia.ImageOnly
                                                )
                                            )
                                        }
                                    },
                                contentAlignment = Alignment.Center,
                            ) {
                                when {
                                    uploadingCover -> CircularProgressIndicator(color = c.accent)
                                    coverLocal != null -> AsyncImage(
                                        model = coverLocal!!.file,
                                        contentDescription = null,
                                        contentScale = ContentScale.Crop,
                                        modifier = Modifier.fillMaxSize(),
                                    )
                                    else -> Text("选择房间封面", style = KType.caption, color = c.textMuted)
                                }
                            }
                            Text(
                                text = if (isLoggedIn) {
                                    "登录用户建房：以你的账号为归属依据"
                                } else {
                                    "访客也能建房；服务端只在建房响应里下发一次归属令牌（本阶段暂不持久化）"
                                },
                                style = KType.tiny,
                                color = c.textMuted,
                            )
                            KButton(
                                text = "创建",
                                onClick = {
                                    if (newName.isBlank()) {
                                        toast = "请填写房间名"
                                        return@KButton
                                    }
                                    scope.launch {
                                        when (val r = voice.createRoom(newName.trim(), newDesc.trim(), coverUrl)) {
                                            is ApiResult.Success -> {
                                                newName = ""
                                                newDesc = ""
                                                coverLocal = null
                                                coverUrl = null
                                                creating = false
                                                toast = "房间已创建"
                                                load()
                                            }
                                            is ApiResult.Failure -> toast = r.error.displayMessage
                                        }
                                    }
                                },
                                enabled = newName.isNotBlank(),
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                    }

                    // 分节标题（设计稿：「正在进行的房间」）
                    Text(
                        text = "正在进行的房间",
                        style = KType.footnote,
                        color = c.textMuted,
                    )
                }
            }

            when {
                loading && rooms.isEmpty() -> item {
                    Box(Modifier.fillMaxWidth().padding(KSpacing.xxl), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(color = c.accent)
                    }
                }

                error != null && rooms.isEmpty() -> item {
                    KPlaceholder(
                        kind = KPlaceholderKind.Error,
                        title = "房间列表加载失败",
                        description = error,
                        action = { KButton("重试", onClick = { scope.launch { load() } }) },
                    )
                }

                rooms.isEmpty() -> item {
                    KPlaceholder(
                        kind = KPlaceholderKind.Empty,
                        title = "还没有语音房",
                        description = "点右上角「新建房间」开一个",
                    )
                }

                else -> items(rooms, key = { it.id }) { room ->
                    // 满员闸门：判据与 Web 端 `VoicePage.tsx` 的 handleJoin 同源，
                    // 由纯函数 canJoinVoiceRoom 给出（勿在此处改写比较符，测试钉的是那一个）。
                    // 满员时**不能静默失效** —— 点了没反应的卡片比不放卡片更让人困惑，
                    // 所以既在卡片上标"已满"，点击时也给一条提示说明原因。
                    val full = !canJoinVoiceRoom(room.participantCount)
                    VoiceRoomCard(
                        room = room,
                        full = full,
                        coverUrl = voice.roomCoverUrl(room),
                        // 进房：真正建立 WebRTC + WS（M3 第 15 项）
                        onClick = {
                            if (full) {
                                // 文案对齐服务端的拒绝理由（messageHandlers.ts 的「房间已满（最多10人）」）
                                toast = "房间已满（最多 $VOICE_MAX_ROOM_SIZE 人）"
                            } else {
                                onOpenRoom(room)
                            }
                        },
                        // 房间上下线时整列表重排走弹簧（M4）
                        modifier = Modifier.animateItem(),
                    )
                }
            }
        }


        if (toast != null) {
            KToast(text = toast!!, onDismiss = { toast = null }, modifier = Modifier.align(Alignment.BottomCenter))
        }
    }
}

/**
 * 房间大卡（设计稿）：内缩的圆角横幅占位 + 房间名 + 一行状态。
 * 设计稿里没有房主/简介行 —— 卡片只承担「这是谁的房、几个人」这一层信息，
 * 详情都在房内。有人时状态后半句用 `accent` 与空房间区分。
 *
 * [full] 为真时（人数已达上限）后半句改成 `textMuted` 的「已满」，**优先于「进行中」**：
 * 满员房间必然有人在，"已满"才是这张卡片点不动的原因，用户要看到的是后者。
 * 颜色沿用本页既有的弱化文字令牌，不新增视觉体系。
 *
 * ## ★ 为什么去掉了 `shadowElevation`（2026-09-24，用户反馈"房间周围的阴影会突然加载"）
 *
 * 原来是 `Surface(shadowElevation = KElevation.card)`。Compose 里 `Surface` 的阴影是由
 * `Modifier.shadow()` 画的 —— 它是一个**独立的 RenderNode 图层**，与卡片自身的
 * 底色 / 内容**不在同一次绘制里**。在这个列表（`LazyColumn` + `items(key)`）首次组合、
 * 或滚动把卡片重新组合时，卡片的底色当帧就画出来了，而那个阴影图层需要**再花一两帧**
 * 才被栅格化 → 观感就是"卡片先出现、阴影**啪**地一下补上"。
 *
 * 本工程的既有约定本来就是「**卡片一律不要阴影**」（消息页行卡、公告卡都不带），
 * 这里属于遗留的例外。改成与全项目一致的做法：**`surface` 底 + 1px `borderSubtle` 收边**。
 * 边框与卡片在**同一次绘制**里，**结构上不可能"晚一步出现"**，问题从根上消失；
 * 也不再需要独立图层，滚动时少一次合成开销。
 *
 * ⚠️ 别再给它加回 `shadowElevation` —— 包括"为了层次感加一点点"。
 */
@Composable
private fun VoiceRoomCard(
    room: VoiceRoom,
    full: Boolean,
    coverUrl: String?,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = KTheme.colors
    val live = room.participantCount > 0
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(KRadius.card),
        color = c.surface,
        // 收边用 borderSubtle（与消息页行卡同一档）；不要阴影，见上面的长注释
        border = BorderStroke(1.dp, c.borderSubtle),
        onClick = onClick,
    ) {
        Column(
            modifier = Modifier.padding(KSpacing.md),
            verticalArrangement = Arrangement.spacedBy(KSpacing.xxs),
        ) {
            // 封面：创建时上传过的显示真实封面；老房间回落占位横幅（无封面字段时期的形态）
            if (coverUrl != null) {
                AsyncImage(
                    // 走 rememberRoomCoverRequest：显式缓存键 + 固定小尺寸 + 不让路给转场动画。
                    // 裸 `model = coverUrl` 会让封面在进页面动画结束前才解码 ——
                    // 用户看到的就是"房间周围的阴影加载了一下"（见该函数的长注释）。
                    model = rememberRoomCoverRequest(coverUrl),
                    contentDescription = null,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(108.dp)
                        .clip(RoundedCornerShape(KRadius.row)),
                )
            } else {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(108.dp)
                        .clip(RoundedCornerShape(KRadius.row))
                        .background(c.surfaceSunken),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("房间封面", style = KType.caption, color = c.textMuted)
                }
            }
            Spacer(Modifier.height(KSpacing.xs))
            Text(
                text = room.name,
                style = KType.bodyStrong,
                color = c.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(KSpacing.xxs),
            ) {
                Text(
                    text = "${room.participantCount} 人在线",
                    style = KType.caption,
                    color = c.textMuted,
                )
                if (full) {
                    Text("· 已满", style = KType.caption, color = c.textMuted)
                } else if (live) {
                    Text("· 进行中", style = KType.caption, color = c.accent)
                }
            }
        }
    }
}
