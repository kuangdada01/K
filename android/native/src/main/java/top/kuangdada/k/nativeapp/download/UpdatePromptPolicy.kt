package top.kuangdada.k.nativeapp.download

/**
 * ============================================================
 * 「这一次要不要弹更新提示」的判据（纯函数，刻意不碰任何 Android API）
 * ============================================================
 * 单独拆一个 object 的理由与 [VersionCompare] 一样：判据写错**不会崩、不会报错**，
 * 只会表现为"用户永远等不到更新提示"或"每次开 App 都被问一遍" ——
 * 这两种症状在真机上都很难发现，所以必须能被 JVM 单测直接钉住
 * （见 `UpdatePromptPolicyTest`，构造器要 Context 的 [AppUpdater] 是没法直接实例化的）。
 *
 * 三条缺一不可：
 *  1. 服务端版本确实比本机新 —— 比较本身在 [AppUpdater.checkForUpdate] 里做，
 *     这里只读结论 [AppUpdater.UpdateCheck.hasUpdate]；
 *  2. 服务端给了**下载地址**。只配了 `APP_VERSION` 没配 `APP_APK_URL` 时，
 *     弹出来也只是个点不动的按钮，宁可不弹（这种情况在调用方记日志留痕）；
 *  3. 这一版不是用户已经点过「以后再说」的那一个 —— **相等即跳过**，
 *     服务端换了版本号（哪怕只是改了位数）就重新提示。
 */
object UpdatePromptPolicy {

    /**
     * @param check 本次检测结果（`hasUpdate` / `latestVersion` / `apkUrl`）
     * @param skippedVersion [UpdateSkipStore.skippedVersion] 的值，null = 没跳过任何版本
     */
    fun shouldPrompt(check: AppUpdater.UpdateCheck, skippedVersion: String?): Boolean {
        if (!check.hasUpdate) return false
        val latest = check.latestVersion?.trim().orEmpty()
        // 有更新却没有版本号：服务端脏数据，不弹（弹了标题就是"发现新版本 "）
        if (latest.isEmpty()) return false
        // 有更新却没有下载地址：弹了也装不上，不弹
        if (check.apkUrl.isNullOrBlank()) return false
        // 两边都 trim 后再比：服务端 .env 里多打一个空格不该变成"又出新版本了"
        return latest != skippedVersion?.trim()
    }
}
