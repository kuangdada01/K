package top.kuangdada.k.nativeapp.download

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ============================================================
 * 更新提示判据单测（UpdatePromptPolicy）
 * ============================================================
 * 用户 09-27 的原话：「**有新版本更新就提示，可以取消，取消就等下一次版本更新再弹窗**」。
 * 这三件事全落在这一个纯函数上，所以逐条钉死：
 *
 *  · 有更新 + 有下载地址 + 没跳过 → 必须弹（少一个条件就"用户永远收不到更新"）；
 *  · 没有下载地址 → **不能**弹（弹了也只是个点不动的按钮）；
 *  · 跳过的**就是这一版** → 不弹（用户要的"取消后别再来烦我"）；
 *  · 跳过的**是别的版本** → 弹（用户要的"下一次版本更新再弹窗"）。
 *
 * 这里全部走 [AppUpdater.UpdateCheck]（对外的数据结构）而不是自己造一个形状，
 * 免得将来字段改名时测试还在"通过"。
 */
class UpdatePromptPolicyTest {

    private fun check(
        hasUpdate: Boolean = true,
        latestVersion: String? = "0.2.0",
        apkUrl: String? = "https://www.kuangdada.top/apk/k-app-0.2.0-release.apk",
        notes: String? = null,
        currentVersion: String = "0.1.0",
    ) = AppUpdater.UpdateCheck(
        hasUpdate = hasUpdate,
        latestVersion = latestVersion,
        apkUrl = apkUrl,
        notes = notes,
        currentVersion = currentVersion,
    )

    // ---------------------------------------------------------------
    // 该弹的
    // ---------------------------------------------------------------

    @Test
    fun `有新版本 有下载地址 没跳过 要弹`() {
        assertTrue(UpdatePromptPolicy.shouldPrompt(check(), skippedVersion = null))
    }

    @Test
    fun `上一版被跳过 服务端又发了新版 要弹`() {
        // 用户 09-27 的原话就是这一条："取消就等下一次版本更新再弹窗"
        assertTrue(UpdatePromptPolicy.shouldPrompt(check(), skippedVersion = "0.1.9"))
    }

    @Test
    fun `服务端回滚到一个仍比本机新的版本 也要弹`() {
        // 跳过的是 0.3.0，服务端回退到 0.2.0：对用户来说"又来了一版"，
        // 严格相等判定天然覆盖这个场景（不必写成"大于已跳过"）
        assertTrue(UpdatePromptPolicy.shouldPrompt(check(latestVersion = "0.2.0"), "0.3.0"))
    }

    // ---------------------------------------------------------------
    // 不该弹的
    // ---------------------------------------------------------------

    @Test
    fun `已经是最新版本 不弹`() {
        assertFalse(
            UpdatePromptPolicy.shouldPrompt(
                check(hasUpdate = false, latestVersion = "0.1.0"),
                skippedVersion = null,
            )
        )
    }

    @Test
    fun `跳过的就是这一版 不弹`() {
        assertFalse(UpdatePromptPolicy.shouldPrompt(check(), skippedVersion = "0.2.0"))
    }

    @Test
    fun `版本号两边有空白差异 仍算同一版`() {
        // 服务端 .env 里多打一个空格不该变成"又出新版本了"（用户会被反复打扰）
        assertFalse(
            UpdatePromptPolicy.shouldPrompt(
                check(latestVersion = " 0.2.0 "),
                skippedVersion = "0.2.0",
            )
        )
    }

    @Test
    fun `只配了版本号没配下载地址 不弹`() {
        assertFalse(UpdatePromptPolicy.shouldPrompt(check(apkUrl = null), skippedVersion = null))
        assertFalse(UpdatePromptPolicy.shouldPrompt(check(apkUrl = ""), skippedVersion = null))
        assertFalse(UpdatePromptPolicy.shouldPrompt(check(apkUrl = "   "), skippedVersion = null))
    }

    @Test
    fun `服务端版本号缺失或空白 不弹`() {
        // 弹出来标题会是"发现新版本 "，纯噪声
        assertFalse(UpdatePromptPolicy.shouldPrompt(check(latestVersion = null), null))
        assertFalse(UpdatePromptPolicy.shouldPrompt(check(latestVersion = ""), null))
        assertFalse(UpdatePromptPolicy.shouldPrompt(check(latestVersion = "  "), null))
    }

    @Test
    fun `跳过记录是空白串时 等同于没跳过`() {
        // 存储里万一存进一个空白（脏数据），应该是"该弹还弹"，而不是永远静音
        assertTrue(UpdatePromptPolicy.shouldPrompt(check(), skippedVersion = ""))
    }
}
