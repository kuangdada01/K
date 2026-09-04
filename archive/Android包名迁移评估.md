# Android 包名迁移评估：`com.mimo.app` → 目标包名

> 状态：**评估文档，未执行**。确认后按「二、迁移步骤」执行。
> 背景：本地项目已 k 化（kuangdada→k），服务器已部署 k 版；Android 客户端仍残留品牌层 `com.mimo.app` 包名。（备注：`mimo` 也出现在 server/books 诗词 txt 中，属内容，与包名无关。）

---

## 一、现状盘点（已扫到的所有 `com.mimo.app` / `mimo` 引用）

| 位置 | 内容 | 必须改? |
|---|---|---|
| `client/capacitor.config.ts:4` | `appId: 'com.mimo.app'` | ✅ 必须（改成目标包名） |
| `client/android/app/build.gradle:4,7` | `namespace = "com.mimo.app"`、`applicationId "com.mimo.app"` | ✅ 必须 |
| `client/android/app/build.gradle:27,29` | `storeFile file('mimo-release.keystore')`、`keyAlias ... ?: 'mimo'` | ⚠️ **别乱改**（见风险2） |
| `client/android/app/src/main/java/com/mimo/app/MainActivity.java:1` | `package com.mimo.app;` | ✅ 目录+package 一起改 |
| `client/android/app/src/main/res/values/strings.xml:5,6` | `package_name = com.mimo.app`、`custom_url_scheme = com.mimo.app` | ✅ 改成目标包名 |
| `client/android/app/src/main/AndroidManifest.xml` | `.MainActivity`（namespace 相对引用）、`${applicationId}.fileprovider` | ✅ **自动跟随**，无需手改包名字面 |

**其它会自动受影响/应一并检查：**
- FileProvider authority = `${applicationId}.fileprovider` → 改包名后自动变为新包名，**无需手改**。
- `client/android/app/src/test/java/com/getcapacitor/myapp/ExampleUnitTest.java`、`androidTest/.../ExampleInstrumentedTest.java` — Capacitor 模板残留的测试类，包名是 `com.getcapacitor.myapp`（**不是 mimo**），与本次无关，可顺手删或不动。
- `mimo-release.keystore` 文件本体不在仓库（gitignore `*.keystore`），是本地签名文件。

---

## 二、迁移步骤（目标包名定后执行）

### 目标包名建议
- 你的对外域名是 `kuangdada.top`（保留项），品牌字是 `Kuangdada`。
- 建议候选（唯一性→短性排序）：
  1. **`top.kuangdada.k`** —— 域名反置 + 品牌 k，唯一性好，与保留域名一致（推荐）
  2. `com.kuangdada.app` —— 简单，但 `com.*.app` 撞名多
  3. `com.k.app` —— 最短，但过度通用、易撞名（不推荐）
- 正式上线前**确认别人没占用**：可在 google/play 控制台预注册检查（评估阶段可先定候选，执行时再确权）。

### 修改项
1. `capacitor.config.ts`：`appId` 改为目标。
2. `build.gradle`：`namespace`、`applicationId` 改为目标。
3. `MainActivity.java`：目录 `com\mimo\app\` 改为 `top\kuangdada\k\`（或按目标包名），文件内 `package` 同步改。
4. `strings.xml`：`package_name`、`custom_url_scheme` 改为目标（**注意**：这个值同时是 Capacitor 深链 scheme，改后旧的 `com.mimo.app://` 链接失效）。
5. 重新同步与构建：
   ```bash
   cd client
   npm run build                # 重新产出 web dist
   npx cap sync android         # 同步 web 资源 + 应用配置（保留自定义原生代码）
   cd android
   .\gradlew.bat assembleRelease   # 需要 keystore 签名（见风险2）
   ```
   > 不要用 `npx cap add android`（会重新生成模板、覆盖自定义 MainActivity/build.gradle）；本工程是定制过的，只应 `sync`。
6. 验证：
   - APK 里的 applicationId：`aapt dump badging app-release.apk | grep package`
   - 启动、状态栏主题、文件上传（FileProvider authority 新包名）回归测试。

---

## 三、风险与注意（改包名最要小心的点）

1. **已发布用户迁移（最重）**
   - Android 的 `applicationId` 是应用**永久身份**，Google Play 发布后**不可改**。
   - 若已有线上 APK：改包名 = **全新应用**（新列表页、重新上架），已安装用户**不能覆盖升级**，需重新下载安装；`localStorage`/`SharedPreferences`（按 applicationId 隔离）**会清空**（除非用迁移逻辑拉取）。
   - **若尚未发布 / 处于内测**：现在改最划算，成本为 0。
2. **签名 keystore 别乱换**
   - 改包名**不需要**换 keystore，仍可继续用 `mimo-release.keystore` 与 alias `mimo`。
   - 若把 keystore 也换成新的 alias/新文件：已发布用户的升级会因**签名指纹变化被系统拒绝**（只能卸载重装），等于叠加“新应用”影响。**建议：包名改、keystore/alias 保持 `mimo` 不变**（除非确认从未发布）。
3. **深链 scheme 变化**
   - `custom_url_scheme`（`strings.xml`）+ appId 变化 → 旧的 `com.mimo.app://` 链接全部失效；如需保留可加 `intent-filter` 兼容旧 scheme。
4. **FileProvider / 文件路径**
   - authority 跟随 applicationId 自动变新；若有代码硬编码旧 authority 需查（当前工程用 `${applicationId}` 模板，安全）。
5. **迁移后需重新构建 + 重新上传所有原生资源**（jar/aars 与 keystore 均在本地，无需动服务器）。

---

## 四、结论与建议

- **若 Android APK 尚未在商店正式发布**（当前 versionCode=1、versionName=0.1.0，疑似早期版本）：**建议现在做**，成本最小，彻底消除 `com.mimo.app` 品牌残留。
- 若已有正式发布用户：改包名成本高（新应用+数据清空），**不建议改**，转而考虑保留 `com.mimo.app` 但把 visible 品牌字改成「K」即可（与 k 一致），文档上注明包名是历史遗留。
- 推荐目标：`top.kuangdada.k`（若需完全避免域名字样可选 `io.k.app`，但更易撞名）。

**待确认项**：①目标包名选哪个；②APK 是否已发布（决定是否值得改）。确认后我按「二、迁移步骤」执行。

---

## ✅ 执行完成（2026-08-25，目标 `com.k.app`，APK 未发布 → 全量迁移）

- ✅ `client/capacitor.config.ts`：`appId: 'com.k.app'`
- ✅ `client/android/app/build.gradle`：`namespace` / `applicationId = com.k.app`
- ✅ `client/android/app/src/main/java/com/k/app/MainActivity.java`：目录迁移 + `package com.k.app`
- ✅ `client/android/app/src/main/res/values/strings.xml`：`package_name` / `custom_url_scheme = com.k.app`
- ✅ `npx cap sync android` 成功（web dist 已重建、android 工程已同步）
- ✅ 静态复核：全项目已无 `com.mimo.app`（仅本评估文档与方案文档的历史描述含旧名）；`mimo` 仅剩 `build.gradle` 的 keystore 引用（有意保留）与 books 诗词内容
- ⚠️ **本机构建验证未完成**：本机无 JDK（无 `JAVA_HOME` / `java`），gradle 无法运行。需在有 JDK 的机器/CI 上验证：
  ```bash
  cd client/android
  .\gradlew.bat assembleDebug        # 先验证编译通过
  # 或正式打板: .\gradlew.bat assembleRelease（需先配好 keystore，见下）
  aapt dump badging app\build\outputs\apk\debug\app-debug.apk | grep package   # 确认 package=com.k.app
  ```
  并确认 `keystore.properties` 与 `mimo-release.keystore` 已放入 `client/android/`（当前本地两者都不存在；keystore alias 保持 `mimo`）。
- 📌 遗留说明：Android 测试模板类位于 `com.getcapacitor.myapp`（非 mimo，与本次无关）；`mimo-release.keystore` 文件名与 alias `mimo` 保留（见风险2，改包名无需换签名）。