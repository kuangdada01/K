# Android 构建警告清理记录（2026-09-16）

> 目的：把 `android/` 工程的构建输出收到"只剩不可为的"状态，并**留下证据**说明
> 每一条残留警告为什么留着 —— 免得下次有人（或 AI）再花一轮去"顺手清掉"结构性的东西。
>
> 复核命令（都要带 `--warning-mode all`，否则 Gradle 只打汇总行、不给位置）：
>
> ```
> node android/scripts/run-gradle.mjs :native:compileDebugKotlin --warning-mode all
> node android/scripts/run-gradle.mjs :native:compileDebugKotlin --rerun-tasks   # 全量重编，才看得到"潜伏"的 Kotlin 警告
> ```
>
> **为什么必须 `--rerun-tasks`**：Kotlin 是增量编译，只给本次重编的文件报警告。
> 平时只改一两个文件时，"干净"是假象 —— 本次就是靠全量重编才翻出 `core:data` 里
> 28 条潜伏警告。

---

## 一、本轮已清掉（3 类 / 9 条）

| 警告                                                                               | 位置                                             | 处理                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Properties should be assigned using the 'propName = value' syntax`（4 条）        | `android/build.gradle` 第 7/8/28/29 行           | `maven { url '…' }` → `maven { url = uri('…') }`                                                                                                                                                        |
| 同上（2 条）                                                                       | `android/native/build.gradle` 第 78/81 行        | `shrinkResources true` → `shrinkResources = true`；`signingConfig signingConfigs.release` → `signingConfig = …`                                                                                         |
| `We recommend using a newer Android Gradle plugin to use compile SDK version 37.0` | `android/gradle.properties`                      | 加 `android.suppressUnsupportedCompileSdk=37.0`（AGP 提示里给的就是这一行）                                                                                                                             |
| `'LocalClipboardManager' is deprecated. Use LocalClipboard instead`（2 处调用点）  | `ui/PostDetailScreen.kt`、`ui/MessagesScreen.kt` | 迁到 `LocalClipboard` + 挂起的 `setClipEntry(ClipEntry(ClipData.newPlainText(...)))`（旧的 `setText` 在 Android 13+ 的剪贴板确认机制下无法处理"写入被拒"）；顺带删掉只为它存在的 `AnnotatedString` 导入 |

关于 Groovy 那 6 条，一个容易踩的点：**只有** `shrinkResources` / `signingConfig` 报警告，
`minifyEnabled true` 不报（它是普通 `boolean`，不是 Gradle 管理的 `Property`）。
所以"顺手全改成 `=`"是没必要的，改动范围按警告来就好。

## 二、保留的机制性警告（2 条，项目侧无法清）

### 1. `The option setting 'android.overridePathCheck=true' is experimental`

**实测证明它不能去掉**（不是推测）：把这一行从 `gradle.properties` 去掉后：

```
FAILURE: Build failed with an exception.
* What went wrong:
> Failed to apply plugin 'com.android.internal.application'.
   > Your project path contains non-ASCII characters. This will most likely cause the build to
     fail on Windows. Please move your project to a different directory.
     This warning can be disabled by adding the line 'android.overridePathCheck=true' to
     gradle.properties file in the project directory.
```

AGP 自己的报错信息就是让你加这一行，而 AGP 没有非实验的同类开关。
根因是工程路径 `E:\资料\项目\k` 含中文。**结论：这条警告是中文路径的结构性代价**；
只有把工程挪到纯 ASCII 路径（或 AGP 将来提供正式开关）才可能消失。

### 2. `Warning: SDK processing. This version only understands SDK XML versions up to 3 but an SDK XML file of version 4 was encountered.`

根因已定位：本机 SDK 里 `platforms/android-37.0/package.xml` 的根元素声明了
`…/repo/repository2/04` 命名空间（schema 版本 4），而 **AGP 9.1.0 的 sdklib 只认到
`repository2/03`**。也就是"装的平台比 AGP 新"。

- 项目侧**没有**对应开关；
- 只能靠升级 AGP（需联网下载，且本机 Gradle 缓存里只有 8.13.0 / 9.1.0，无更新版本）
  或用更老的 cmdline-tools 重装平台 —— 两条都属于工具链变更，不该混在"清警告"里做；
- 影响面：AGP 会警告后继续，`compileDebugKotlin` / `processDebugResources` 均正常通过。

**决策：保留，等下次升 AGP 时一并消失。**

## 三、保留但属于 AGP 自己的债（1 条）

```
Using a Project object as a dependency notation has been deprecated.
This will fail with an error in Gradle 10.
```

我一开始误判成 `native/build.gradle` 里的 `implementation project(':core:data')`，
改成 `project(path: ':core:data')` 后**警告依旧**。用 `--stacktrace` 才定位到真正来源：

```
at com.android.build.gradle.internal.dependency.VariantDependenciesBuilder.build(VariantDependenciesBuilder.java:279)
at com.android.build.gradle.internal.VariantManager.createTestComponents(VariantManager.kt:652)
```

即 **AGP 9.1.0 内部**为测试组件建依赖时用了旧写法。项目侧无从修改，
`native/build.gradle` 里那两行保持原样（已加注释，防止下一个人再改一遍）。
真要在 Gradle 10 之前解决，只能升级 AGP。

## 四、Kotlin 警告：A 档已清，只剩 B / C 档

**这些都不是动效改动引入的**（`--rerun-tasks` 全量重编即可复现）。清理前的真实基线是 **29 条**，
按"能不能顺手清"分三档。A 档已于同日清完（全量重编复核：29 → 11）。

### A 档 · 已清（18 条）

| 数量 | 警告                                           | 位置                                                                                                                 | 处理                                                   |
| ---- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 13   | `Expression is unused`                         | `core/data`: `AdminRepository`(6)、`CommentRepository`(1)、`ContentRepositories`(1)、`MessageRepository`(5)          | 删掉**尾随的多余 `Unit`**（见下方"注意"）              |
| 2    | `Unnecessary safe call on a non-null receiver` | `core/data/GeoRepository.kt:53`（`response.body?.string()`）、`voice/VoiceSession.kt:510`（`qlr?.toString()`）       | 去掉 `?.`：OkHttp 5 起 `body` 非空；`qlr` 是非空 `Any` |
| 3    | `Redundant call of conversion method`          | `ui/Format.kt:15`（`uppercase(Locale)` 已返回 String）、`ui/LocationPickerScreen.kt:349,350`（`Dp / Dp` 已是 Float） | 去掉多余的 `.toString()` / `.toFloat()`                |

**关于那 13 条 `Expression is unused`，有一个必须知道的坑**：它们全部指向**尾随的 `Unit`**，
形如 `call { session.api.admin.deleteUser(userId); Unit }`。这个 `Unit` 不是废代码 ——
它是有意用来**丢掉 API 响应体**的（接口返回 `SimpleSuccess` / `ServerMessage` / `BanResult`，
而仓库方法声明的是 `ApiResult<Unit>`）。所以正确改法是**删掉 `Unit`、让块尾表达式由声明返回类型
推断/强制为 Unit**，而不是把 `Unit` 换成别的、更不是留着它：

```kotlin
// 之前（编译器报 UNUSED_EXPRESSION）
suspend fun delete(id: Long): ApiResult<Unit> = call { api.delete(id); Unit }
// 之后（语义完全不变）
suspend fun delete(id: Long): ApiResult<Unit> = call { api.delete(id) }
```

**别误伤**：`PostRepository.kt:373` 的 `val result = request { …; Unit }` 长得一样，但那里的 `Unit`
**是返回值（被 `result` 用了）**，编译器不报警告 —— 动了它就是没必要的改动。
判断口径：只有"`; Unit }` 作为 lambda 尾表达式、且 lambda 期望类型是 Unit"的那批才是这条警告。

### B 档 · 需要真机验证，别顺手做（1 条）

`ui/viewer/ZoomableImage.kt:91`：`rememberTransformableState(onTransformation: (Float, Offset, Float) -> Unit)`
已废弃，官方建议换成带 **centroid（变换中心点）** 的重载 —— 直接换会改变双指缩放/旋转的
锚点行为，属于"观感 + 手势手感"变更，应与动效一起上真机看（M5 图片查看器改造时一并处理最合适）。

### C 档 · 属于依赖库整体废弃，不是"清警告"能解决的（10 条）

`core/data/TokenStore.kt`（**9 条**）用的 `EncryptedSharedPreferences` / `MasterKey` / `KeyScheme` /
`PrefKeyEncryptionScheme` / `PrefValueEncryptionScheme` 在 `androidx.security:security-crypto 1.1.0`
里**整类被标记废弃**（Google 的方向是 DataStore + 自管 Keystore 密钥）。
换掉它等于**重写令牌存储的加密方案**，是安全敏感改动，必须单独一次改动 + 迁移老数据 + 真机验证，
**不能当作"清警告"顺手做**。

`voice/RoomRecorder.kt:65`（`This class is not recommended for use in Kotlin. Use 'kotlin.Any'`）
属于"给 Java 互操作留的类在 Kotlin 里不该用"，同样属独立小改动。

---

## 五、下次动这块时的入口

1. 先跑一次 `--rerun-tasks` 的全量编译，拿到**当前真实**的警告基线（增量编译会骗人）；
   清完 A 档后的基线是 **11 条**（9 TokenStore + 1 ZoomableImage + 1 RoomRecorder）；
2. A 档已清，新增改动请保持这个基线不再上涨；
3. B 档跟着图片查看器（M5）一起做；
4. C 档单独立项（令牌存储迁移）；
5. 升 AGP 时：`android.suppressUnsupportedCompileSdk` 与本文件第二节的 SDK XML 警告一起复查，
   能删则删。

## 六、本轮清理的净结果

| 项                                 | 清理前                                                    | 清理后                          |
| ---------------------------------- | --------------------------------------------------------- | ------------------------------- |
| Gradle 脚本弃用（Groovy 空格赋值） | 6                                                         | **0**                           |
| Gradle 构建警告                    | 4（compileSdk 37 / 路径检查 / SDK XML v4 / Project 依赖） | 3（后三条为机制性，见二、三节） |
| Kotlin 警告（全量重编）            | 29                                                        | **11**（全在 B/C 档）           |
| 单测                               | 183 通过                                                  | 183 通过                        |
