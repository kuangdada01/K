package top.kuangdada.k.nativeapp.ui

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.os.Looper
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import coil3.compose.AsyncImage
import kotlin.math.PI
import kotlin.math.atan
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.pow
import kotlin.math.sinh
import kotlin.math.tan
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import top.kuangdada.k.core.data.ApiResult
import top.kuangdada.k.core.data.GeoRepository
import top.kuangdada.k.core.data.displayMessage
import top.kuangdada.k.core.designsystem.component.KButton
import top.kuangdada.k.core.designsystem.component.KButtonVariant
import top.kuangdada.k.core.designsystem.theme.KDimens
import top.kuangdada.k.core.designsystem.theme.KRadius
import top.kuangdada.k.core.designsystem.theme.KSpacing
import top.kuangdada.k.core.designsystem.theme.KTheme
import top.kuangdada.k.core.designsystem.theme.KType

/**
 * ============================================================
 * 地图选点（发布弹层的「位置」）
 * ============================================================
 * 用户要求：**接 GPS + 地图上选点**，不要自己手输地址。
 *
 * 为什么是自绘瓦片地图，而不是高德/腾讯/Google 地图 SDK：
 *  · Google Maps SDK 依赖 Google Play 服务（国内 ROM 普遍没有），真机上起不来；
 *  · 高德/腾讯/百度 SDK 都要申请 key 并绑定包名+签名，本项目没有这类账号依赖；
 *  · 所以用**免 key 的 OSM 栅格瓦片**（`tile.openstreetmap.de`，实测国内可直连；
 *    官方 `tile.openstreetmap.org` 与 carto 在国内直连超时）自己铺瓦片：
 *    拖动/双指缩放改的是"中心经纬度 + 缩放级别"，屏幕正中永远是一枚固定图钉，
 *    停手后用逆地理接口（[GeoRepository]）把图钉坐标变成中文地名。
 *
 * 瓦片数学（Web Mercator，标准公式）：
 *   worldX = (lon + 180) / 360 * 2^z
 *   worldY = (1 - ln(tan(lat) + sec(lat)) / π) / 2 * 2^z
 *   反向：lon = worldX / 2^z * 360 - 180，lat = atan(sinh(π(1 - 2·worldY/2^z)))
 */
private const val MIN_ZOOM = 3f
private const val MAX_ZOOM = 19f

/** 单块瓦片画多大（256px 源图 → 128dp ≈ 高 DPI 屏 1.75×，清晰度与请求数的折中） */
private val TILE_SIZE = 128.dp

/** 免 key 瓦片源（实测国内直连可用） */
private fun tileUrl(z: Int, x: Int, y: Int) = "https://tile.openstreetmap.de/$z/$x/$y.png"

/** 拿不到定位时的兜底中心（北京天安门），避免一进来是片海 */
private const val DEFAULT_LAT = 39.9087
private const val DEFAULT_LON = 116.3975

@Composable
fun LocationPickerScreen(
    /** 当前是否已有位置（有则提供「不显示位置」） */
    hasLocation: Boolean,
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit,
) {
    val c = KTheme.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val geo = remember { GeoRepository() }

    var lat by remember { mutableStateOf(DEFAULT_LAT) }
    var lon by remember { mutableStateOf(DEFAULT_LON) }
    var zoom by remember { mutableStateOf(15f) }
    var resolved by remember { mutableStateOf<String?>(null) }
    var resolving by remember { mutableStateOf(false) }
    var locating by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    // 进页面先尝试定位到"我"（有权限才做；没权限直接拖地图也行）
    LaunchedEffect(Unit) {
        if (context.hasLocationPermission()) {
            locating = true
            context.awaitCurrentLocation()?.let {
                lat = it.latitude
                lon = it.longitude
                zoom = 16f
            }
            locating = false
        }
    }

    /**
     * 中心点变化后**停手 600ms** 再逆地理：拖动过程中每一帧都会改 lat/lon，
     * 这个 effect 因而被不断重启，天然就是防抖（第三方接口有限流，不能每帧打）。
     */
    LaunchedEffect(lat, lon) {
        delay(600)
        resolving = true
        error = null
        when (val r = geo.reverse(lat, lon)) {
            is ApiResult.Success -> resolved = r.data
            is ApiResult.Failure -> {
                resolved = null
                error = r.error.displayMessage
            }
        }
        resolving = false
    }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { granted ->
        if (granted.values.any { it }) {
            scope.launch {
                locating = true
                context.awaitCurrentLocation()?.let {
                    lat = it.latitude
                    lon = it.longitude
                    zoom = 16f
                }
                locating = false
            }
        } else {
            error = "没有定位权限，可以直接拖动地图选点"
        }
    }

    Box(modifier = Modifier.fillMaxSize().background(c.bgPage)) {
        Column(modifier = Modifier.fillMaxSize()) {
            // ---- 顶栏：取消 / 选择位置 ----
            // 垂直位置走全 App 同一条 kTopBar（见 KWidgets.kTopBar），这里只写左右与下边距
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .kTopBar()
                    .padding(start = KSpacing.md, end = KSpacing.md, bottom = KSpacing.xs),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                KButton(text = "取消", onClick = onDismiss, variant = KButtonVariant.Danger, compact = true)
                Text(
                    text = "选择位置",
                    style = KType.subtitle,
                    color = c.textPrimary,
                    modifier = Modifier.weight(1f),
                    textAlign = TextAlign.Center,
                )
                // 右侧留出与「取消」等宽的占位，保证标题真正居中
                Spacer(Modifier.size(width = 56.dp, height = 1.dp))
            }

            // ---- 地图（图钉固定在正中，地图在它下面动） ----
            Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                TileMap(
                    lat = lat,
                    lon = lon,
                    zoom = zoom,
                    onPan = { dTileX, dTileY, zInt ->
                        lon = normalizeLon(lon + dTileX * 360.0 / (1 shl zInt))
                        val newWorldY = latToWorldY(lat, zInt) + dTileY
                        lat = worldYToLat(newWorldY, zInt).coerceIn(-85.0, 85.0)
                    },
                    onZoomChange = { zoom = it },
                )
                CenterPin(modifier = Modifier.align(Alignment.Center))

                // 回到我的位置
                Box(
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .padding(KSpacing.md)
                        .size(KDimens.iconButton)
                        .clip(RoundedCornerShape(percent = 50))
                        .background(c.surface)
                        .border(1.dp, c.borderStrong, RoundedCornerShape(percent = 50))
                        .clickable {
                            if (context.hasLocationPermission()) {
                                scope.launch {
                                    locating = true
                                    context.awaitCurrentLocation()?.let {
                                        lat = it.latitude
                                        lon = it.longitude
                                        zoom = 16f
                                    }
                                    locating = false
                                }
                            } else {
                                permissionLauncher.launch(
                                    arrayOf(
                                        Manifest.permission.ACCESS_FINE_LOCATION,
                                        Manifest.permission.ACCESS_COARSE_LOCATION,
                                    )
                                )
                            }
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    if (locating) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(18.dp),
                            strokeWidth = 2.dp,
                            color = c.accent,
                        )
                    } else {
                        CrosshairIcon(tint = c.accent, size = 20.dp)
                    }
                }
            }

            // ---- 底部：解析出的地名 + 确认 ----
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(c.surface)
                    .navigationBarsPadding()
                    .padding(KSpacing.md),
                verticalArrangement = Arrangement.spacedBy(KSpacing.sm),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = when {
                            resolving -> "正在解析地点…"
                            !resolved.isNullOrBlank() -> resolved!!
                            else -> "这个点没有地名"
                        },
                        style = KType.bodyStrong,
                        color = if (!resolved.isNullOrBlank()) c.textPrimary else c.textMuted,
                        modifier = Modifier.weight(1f),
                    )
                    if (resolving) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(16.dp),
                            strokeWidth = 2.dp,
                            color = c.accent,
                        )
                    }
                }
                if (error != null) {
                    Text(error!!, style = KType.footnote, color = c.danger)
                }
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (hasLocation) {
                        KButton(
                            text = "不显示位置",
                            onClick = { onConfirm("") },
                            variant = KButtonVariant.Secondary,
                            compact = true,
                        )
                    }
                    Spacer(Modifier.weight(1f))
                    KButton(
                        text = "用这个点",
                        onClick = { onConfirm(resolved.orEmpty()) },
                        enabled = !resolving,
                        compact = true,
                    )
                }
                Text(
                    text = "地图数据 © OpenStreetMap 贡献者 · 拖动选点，双指缩放",
                    style = KType.tiny,
                    color = c.textMuted,
                )
            }
        }
    }
}

/**
 * 瓦片地图：按中心/缩放算出可见瓦片范围，逐块铺 [AsyncImage]。
 *
 * 手势用 `detectTransformGestures`（拖动 + 双指缩放一起给）。注意 `pointerInput(Unit)`：
 * 若把 zoom 放进 key，手势检测器会在每次缩放后重建，捏合会被打断 —— 所以移动量
 * 以"瓦片格数"回传给调用方，由它用**当前**经纬度换算，手势协程始终不重启。
 */
@Composable
private fun TileMap(
    lat: Double,
    lon: Double,
    zoom: Float,
    onPan: (dTileX: Double, dTileY: Double, zInt: Int) -> Unit,
    onZoomChange: (Float) -> Unit,
) {
    BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
        val widthDp = maxWidth
        val heightDp = maxHeight

        val zInt = floor(zoom).toInt().coerceIn(MIN_ZOOM.toInt(), MAX_ZOOM.toInt())
        val scale = 2f.pow(zoom - zInt)
        val drawnTile: Dp = TILE_SIZE * scale

        val worldX = lonToWorldX(lon, zInt)
        val worldY = latToWorldY(lat, zInt)
        // Dp / Dp 的结果本来就是 Float，`.toFloat()` 多余（编译器报 Redundant call of conversion method）
        val tilesX = (widthDp / drawnTile)
        val tilesY = (heightDp / drawnTile)

        val firstX = floor(worldX - tilesX / 2f).toInt()
        val firstY = floor(worldY - tilesY / 2f).toInt()
        val lastX = floor(worldX + tilesX / 2f).toInt()
        val lastY = floor(worldY + tilesY / 2f).toInt()
        val maxIndex = 1 shl zInt

        // 手势里的最新状态（避免把 zoom 放进 pointerInput 的 key 导致捏合被打断）
        val latestZoom by rememberUpdatedState(zoom)
        val latestZInt by rememberUpdatedState(zInt)
        val density = LocalDensity.current

        Box(
            modifier = Modifier
                .fillMaxSize()
                .pointerInput(Unit) {
                    detectTransformGestures { _, pan, gestureZoom, _ ->
                        val tilePx = with(density) { (TILE_SIZE * 2f.pow(latestZoom - latestZInt)).toPx() }
                        if (tilePx > 0f) {
                            onPan(-pan.x.toDouble() / tilePx, -pan.y.toDouble() / tilePx, latestZInt)
                        }
                        if (gestureZoom != 1f) {
                            onZoomChange((latestZoom + (gestureZoom - 1f) * 2f).coerceIn(MIN_ZOOM, MAX_ZOOM))
                        }
                    }
                },
        ) {
            for (ty in firstY..lastY) {
                if (ty < 0 || ty >= maxIndex) continue
                for (tx in firstX..lastX) {
                    val wrappedX = ((tx % maxIndex) + maxIndex) % maxIndex
                    val offsetX = ((tx - (worldX - tilesX / 2f)) * scale).toFloat()
                    val offsetY = ((ty - (worldY - tilesY / 2f)) * scale).toFloat()
                    AsyncImage(
                        model = tileUrl(zInt, wrappedX, ty),
                        contentDescription = null,
                        modifier = Modifier
                            .offset(x = TILE_SIZE * offsetX, y = TILE_SIZE * offsetY)
                            .size(drawnTile),
                    )
                }
            }
        }
    }
}

/** 屏幕中心的图钉（自绘：圆头 + 尖脚 + 白心） */
@Composable
private fun CenterPin(modifier: Modifier = Modifier) {
    val c = KTheme.colors
    Box(modifier = modifier.size(width = 28.dp, height = 36.dp)) {
        Canvas(modifier = Modifier.fillMaxSize()) {
            val w = size.width
            val h = size.height
            val headR = w / 2f
            val cx = w / 2f
            val headCy = headR + 2f
            val foot = Path().apply {
                moveTo(cx, h)
                lineTo(cx - headR * 0.55f, headCy + headR * 0.8f)
                lineTo(cx + headR * 0.55f, headCy + headR * 0.8f)
                close()
            }
            drawPath(foot, color = c.accent)
            drawCircle(color = c.accent, radius = headR, center = Offset(cx, headCy))
            drawCircle(color = Color.White, radius = headR * 0.42f, center = Offset(cx, headCy))
        }
    }
}

/** 「回到我的位置」的准星（不引第三方图标库） */
@Composable
private fun CrosshairIcon(tint: Color, size: Dp) {
    Canvas(modifier = Modifier.size(size)) {
        val r = this.size.minDimension / 2f
        val center = Offset(this.size.width / 2f, this.size.height / 2f)
        val stroke = r * 0.16f
        drawCircle(color = tint, radius = r * 0.40f, center = center, style = Stroke(width = stroke))
        drawCircle(color = tint, radius = r * 0.12f, center = center)
        drawLine(tint, Offset(center.x, center.y - r), Offset(center.x, center.y - r * 0.6f), strokeWidth = stroke)
        drawLine(tint, Offset(center.x, center.y + r * 0.6f), Offset(center.x, center.y + r), strokeWidth = stroke)
        drawLine(tint, Offset(center.x - r, center.y), Offset(center.x - r * 0.6f, center.y), strokeWidth = stroke)
        drawLine(tint, Offset(center.x + r * 0.6f, center.y), Offset(center.x + r, center.y), strokeWidth = stroke)
    }
}

// ---------------------------------------------------------------
// GPS：用系统 LocationManager（**不依赖 Google Play 服务**，国内 ROM 上不存在）
// ---------------------------------------------------------------

private fun Context.locationManager(): LocationManager? =
    getSystemService(Context.LOCATION_SERVICE) as? LocationManager

internal fun Context.hasLocationPermission(): Boolean =
    ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) ==
        PackageManager.PERMISSION_GRANTED ||
        ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) ==
        PackageManager.PERMISSION_GRANTED

/**
 * 取一次当前位置，最多等 8 秒（超时返回 null）。
 *
 * API 30+ 用 `getCurrentLocation`；老系统回退 `requestSingleUpdate`（已废弃但可用），
 * 再兜底 `getLastKnownLocation`（室内/刚开机往往只有这个）。
 */
@SuppressLint("MissingPermission")
private suspend fun Context.awaitCurrentLocation(): Location? {
    if (!hasLocationPermission()) return null
    val lm = locationManager() ?: return null
    val provider = when {
        lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER) -> LocationManager.NETWORK_PROVIDER
        lm.isProviderEnabled(LocationManager.GPS_PROVIDER) -> LocationManager.GPS_PROVIDER
        else -> null
    } ?: return null

    val last = runCatching { lm.getLastKnownLocation(provider) }.getOrNull()
    val fresh = withTimeoutOrNull(8_000) {
        withContext(Dispatchers.Main) {
            suspendCancellableCoroutine<Location?> { cont ->
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    lm.getCurrentLocation(provider, null, mainExecutor) { loc ->
                        cont.resumeWith(Result.success(loc))
                    }
                } else {
                    @Suppress("DEPRECATION")
                    lm.requestSingleUpdate(
                        provider,
                        object : android.location.LocationListener {
                            override fun onLocationChanged(location: Location) {
                                cont.resumeWith(Result.success(location))
                            }

                            @Deprecated("旧签名，必须实现")
                            override fun onStatusChanged(p: String?, status: Int, extras: android.os.Bundle?) = Unit

                            override fun onProviderEnabled(provider: String) = Unit

                            override fun onProviderDisabled(provider: String) = Unit
                        },
                        Looper.getMainLooper(),
                    )
                }
            }
        }
    }
    return fresh ?: last
}

// ---------------------------------------------------------------
// Web Mercator 换算
// ---------------------------------------------------------------

private fun lonToWorldX(lon: Double, z: Int): Double = (lon + 180.0) / 360.0 * (1 shl z)

private fun latToWorldY(lat: Double, z: Int): Double {
    val rad = Math.toRadians(lat)
    val y = (1.0 - ln(tan(rad) + 1.0 / cos(rad)) / PI) / 2.0 * (1 shl z)
    return y.coerceIn(0.0, (1 shl z).toDouble())
}

private fun worldYToLat(worldY: Double, z: Int): Double {
    val n = PI - 2.0 * PI * worldY / (1 shl z)
    return Math.toDegrees(atan(sinh(n)))
}

private fun normalizeLon(lon: Double): Double {
    var v = lon
    while (v > 180.0) v -= 360.0
    while (v < -180.0) v += 360.0
    return v
}
