# OPPO 无缝动画 · 参数存档（供自研动画复刻）

> 2026-10-10 · 数据来源：**真机日志 `OplusViewSeamlessRemoteManager` 的
> `SeamlessAnimInfo`**（一手，非推测）+ 实测时长统计
> 设备：OnePlus PGEM10 / ColorOS 16.0.5 / `getVersion()=37001` / 屏幕 1440×3168
>
> 背景：该方案因**残留快照**问题被放弃（详见
> `docs/android-seamless-residue-investigation.md`）。
> 本文件把它的**视觉参数**完整存档，供后续自研动画对标复刻。

## 1. 一句话概括它做了什么

把「列表里的卡片」与「全屏二级页」之间的切换，做成**一次连贯的几何形变**：
卡片矩形 ⇄ 全屏矩形，同时伴随圆角、位移、缩放、透明度的联动变化，
**由系统渲染**（App 掉帧不拖累它），进出**成对**、**可打断**。

## 2. 时长与节奏（实测）

| 指标          | 值                                         |
| ------------- | ------------------------------------------ |
| 展开（OPEN）  | **~505ms**（样本区间 497–544ms）           |
| 收缩（CLOSE） | **~505ms**（同上，两端对称）               |
| 曲线类型      | **弹簧（Spring）**，非缓动曲线             |
| 可打断        | 是（`mergeAnimation`：新动画可合并旧动画） |

## 2.1 已经对齐到本工程（2026-10-10）

用户反馈原页面转场"有点快"后，已按本文件的实测值调整现有 Compose 转场
（**不是**恢复无缝方案，只是把观感对齐）：

| 项           | 调整前             | 调整后                 | 依据                          |
| ------------ | ------------------ | ---------------------- | ----------------------------- |
| 页面滑动弹簧 | `k=3200`（~230ms） | **`k=1300`（~360ms）** | OPPO 实测 505ms，原值仅其 45% |
| 进场淡入     | `effects(Fast)`    | `effects(Default)`     | 滑动变长后淡入需同步跟上      |
| 出场淡出     | `effects(Fast)`    | **不变**（刻意）       | 旧页多留一帧 = 多一帧叠影     |

代码位置：`KMotion.pageSlide()` + `AppShell.pageTransform()`。
**未直接取 505ms**：整页转场时长同时就是「转场期手势锁」时长
（`scrollLocked = isPageTransitioning()`），505ms 会让"进详情想马上滑动"明显变钝 ——
那是 2026-10-04 已经付过代价的坑。360ms 是折中值；
要继续放慢**只改 `pageSlide()` 的 stiffness**：`900 ≈ 434ms`、`664 ≈ 505ms`。

> ⚠️ 样本里有一个 **124ms** 的离群值 —— 出现在"快速返回"时，
> 即**上一次转场被下一次操作打断、弹簧未走完就被合并**。
> 自研时如果要做打断，这是需要处理的边界。

**复刻建议**：用 `SpringAnimation`（`androidx.dynamicanimation`）或
Compose 的 `spring(dampingRatio, stiffness)`，不要用 `tween`。
实测两端时长一致，说明进/出用**同一套弹簧参数**。

## 3. 几何映射（真机样本，逐字段）

样本：首页卡片 `Rect(56, 391 - 1384, 1564)`（1328×1173）→ 全屏。
屏幕 `1440×3168`。

### 3.1 展开（OPEN，`isExpand=true`）

| 字段                    | 从（卡片）    | 到（全屏） | 含义                       |
| ----------------------- | ------------- | ---------- | -------------------------- |
| `translateX`            | 56.0          | 0.0        | 卡片左边距 → 0             |
| `translateY`            | 391.0         | 0.0        | 卡片顶边距 → 0             |
| `scaleX` / `scaleY`     | **0.9222222** | 1.0        | 缩放比 → 1                 |
| `fromCorner`→`toCorner` | 63.0          | **70.0**   | 圆角 px → 70               |
| `alpha`（源 view）      | 1.0           | **0.0**    | **源卡片渐隐**             |
| `backActivityAlpha`     | 1.0           | **0.5**    | **被覆盖的页面压暗到 50%** |

### 3.2 收缩（CLOSE，`isExpand=false`）

**严格反向**（同一组数值反过来）：

| 字段                    | 从（全屏） | 到（卡片）    |
| ----------------------- | ---------- | ------------- |
| `translateX` / `Y`      | 0.0 / 0.0  | 56.0 / 391.0  |
| `scaleX` / `scaleY`     | 1.0        | **0.9222222** |
| `fromCorner`→`toCorner` | 70.0       | **63.0**      |
| `alpha`（源 view）      | 0.0        | **1.0**       |
| `backActivityAlpha`     | 0.5        | **1.0**       |

> ★ **关键视觉点：`backActivityAlpha` 的 1.0 → 0.5 → 1.0**
> 转场期间把下层页面**压暗到 50%**，结束时恢复。
> 这是"层次感"的主要来源，自研时**务必复刻**，否则会显得很平。

## 4. 数值是怎么算出来的（公式）

### 4.1 `realScale`（起始缩放比）

```
realScale = 卡片在屏幕上的"实际可视比例"
          = 0.9222222   （本例）
```

本例中它**不等于** `卡片宽/屏宽 = 1328/1440 = 0.9222` —— 两者恰好相等，
说明该卡片的可视宽度就是屏宽比例，且**高度方向用同一比例**
（`scaleX == scaleY`，即**等比缩放，不拉伸**）。

**自研公式**：

```
scaleFrom = cardWidth / screenWidth          // 等比
translateFromX = cardLeft
translateFromY = cardTop
```

### 4.2 圆角

```
fromCorner = 卡片的实际圆角 px   （本例 63.0 = 18dp @3.5x，即 KRadius.card）
toCorner   = 70.0                （全屏态的圆角，≈ 20dp @3.5x）
```

> ⚠️ 注意 `toCorner=70` **不是 0** —— 全屏页也保留了一点圆角。
> 自研时若直接归零会与系统观感不同。

### 4.3 `clipRect` / `screenBounds`（裁剪）

```
screenBounds = Rect(0, 0 - 1440, 3168)     // 全屏
clipRect     = Rect(0, 0 - 1440, 1271)     // 可裁剪区域（考虑状态栏等）
```

`clipFrom` / `clipTo` 在展开时是 `clipRect → screenBounds`，
即**裁剪区域随动画一起放大**。自研时可用 `Modifier.clipToBounds()` +
`graphicsLayer` 近似。

## 5. 打开方式（接入形态，供参考其"交互契约"）

原始接入方式（已废弃，仅记录其**触发时机与交互语义**）：

```kotlin
// 1) 点击卡片时：声明"这次 startActivity 走无缝"
val bundle = Bundle().apply {
    putBoolean(VIEW_SEAMLESS_OPEN, true)   // 声明无缝
    putFloat(BUNDLE_RADIUS, cornerPx)      // 卡片圆角（必传）
    putInt(BUNDLE_COLOR, color)            // 兜底色（可省）
}
OplusViewSeamless.setSeamlessView(view, activity, bundle, callback)
// 2) 再启动
startActivity(intent, bundle)
```

**交互契约（这部分值得自研时保留）**：

| 行为           | 语义                                               |
| -------------- | -------------------------------------------------- |
| 点击卡片       | 卡片**原地展开**成全屏，源卡片渐隐、下层压暗到 50% |
| 返回           | **反向**收缩回卡片原位（几何按"卡片实时位置"算）   |
| 转场中滑动列表 | 动画**可被打断/合并**（不是"锁死到播完"）          |
| 双向           | 进与出是**成对的同一条曲线**，时长一致             |

> ★ 这几条是**产品级的好体验**，与"用谁的动画实现"无关。
> 自研时建议保留这套语义。

## 6. 自研复刻的落点建议

现有工程里已有可复用的基建（**不要去碰无缝那套已废弃的代码**）：

| 需求         | 可复用资产                                                     |
| ------------ | -------------------------------------------------------------- |
| 卡片实时几何 | `ui/ViewerOrigins.kt`（登记表 + 落定值规则，已在查看器上验证） |
| 单页转场编排 | `ui/AppShell.kt` 的 `AnimatedContent` + `transitionSpec`       |
| 共享元素     | `ui/SharedElements.kt`（`sharedBoundsIfAvailable` 等）         |
| 动效常量     | `ui/…` 里 `KMotion.effects()`（已有统一动效参数）              |

**最小可行方案**：既然已回到单 Activity，
用 **Compose 共享元素**（`SharedTransitionLayout` + `sharedBounds`）
就能做出"整卡展开/收缩"的观感 —— 这正是无缝方案当初**替代掉**的东西
（见 `docs/android-seamless-animation-plan.md` §0 决策 3）。
参数按本文件 §3/§4 对标即可（弹簧 ~505ms、等比缩放、
`backActivityAlpha` 0.5 压暗、圆角 63↔70）。

> ⚠️ 注意：无缝方案当初留下的一个**副作用**是把详情页搬去了另一个
> Activity（`PushHostActivity`），导致 Compose 共享元素**跨不了窗口**而失效。
> 回滚后这一点自动恢复 —— 共享元素又能用了。

## 7. 数据可信度

| 项                           | 来源                                     | 可信度 |
| ---------------------------- | ---------------------------------------- | ------ |
| 时长 505ms / 弹簧            | 真机 `all spring finish, duration:` 统计 | ★★★ 高 |
| 各几何字段数值               | 真机 `SeamlessAnimInfo{...}` 原文        | ★★★ 高 |
| `toCorner=70` 的语义         | 日志数值（官方文档未明说）               | ★★ 中  |
| 弹簧的具体 stiffness/damping | **日志未暴露**（只有结果时长）           | ★ 低   |

> 弹簧的 `dampingRatio` / `stiffness` **无法从日志得到**，
> 只能通过"时长 ≈505ms + 视觉手感"反推。自研时建议用
> `spring(dampingRatio = 0.9f, stiffness = Spring.StiffnessMedium)` 起步再微调。
