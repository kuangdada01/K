package top.kuangdada.k.nativeapp.download

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ============================================================
 * 版本比较单测（AppUpdater.isNewer → VersionCompare.isNewer）
 * ============================================================
 * 这段逻辑的价值全在边界上：写错了**不会崩、不会报错**，
 * 只会表现为"用户看不到更新提示"或"天天提示更新"。
 * 尤其是 `1.10.0` vs `1.9.0` —— 字符串比较会得出相反结论，
 * 而版本号一进入两位数就必然踩到，所以这里逐条钉死。
 *
 * 断言走 `AppUpdater.isNewer`（对外的入口）而不是直接走 `VersionCompare`：
 * 这样连"转发没接错"也一起钉住了。
 */
class AppUpdaterTest {

    // ---------------------------------------------------------------
    // 基本：同版本不更新、小版本递增要更新
    // ---------------------------------------------------------------

    @Test
    fun `相同版本不算更新`() {
        assertFalse(AppUpdater.isNewer("1.2.3", "1.2.3"))
    }

    @Test
    fun `补丁号更高要更新`() {
        assertTrue(AppUpdater.isNewer("1.2.4", "1.2.3"))
        // 反向必须为 false，否则会出现"降级提示"
        assertFalse(AppUpdater.isNewer("1.2.3", "1.2.4"))
    }

    @Test
    fun `次版本更高要更新`() {
        assertTrue(AppUpdater.isNewer("1.3.0", "1.2.9"))
        assertFalse(AppUpdater.isNewer("1.2.9", "1.3.0"))
    }

    // ---------------------------------------------------------------
    // 关键边界：必须按数字比，不能按字符串比
    // ---------------------------------------------------------------

    @Test
    fun `1_10_0 比 1_9_0 新（字符串比较会判错）`() {
        // 字符串比较："1.10.0" < "1.9.0"（'1' < '9'）→ 会漏掉整个 1.10 版本
        assertTrue(AppUpdater.isNewer("1.10.0", "1.9.0"))
        assertFalse(AppUpdater.isNewer("1.9.0", "1.10.0"))
        // 同理，主版本号进位也不能掉进字符串陷阱
        assertTrue(AppUpdater.isNewer("10.0.0", "9.9.9"))
    }

    @Test
    fun `大版本号跨位比较`() {
        assertTrue(AppUpdater.isNewer("2.0", "1.9.9"))
        assertFalse(AppUpdater.isNewer("1.9.9", "2.0"))
    }

    @Test
    fun `数字段超长不溢出（按 Long 比较）`() {
        assertTrue(AppUpdater.isNewer("1.99999999999", "1.9"))
        // 超过 Long 范围时退回字符串比较，至少不抛异常
        assertTrue(AppUpdater.isNewer("1.99999999999999999999999999", "1.9"))
    }

    // ---------------------------------------------------------------
    // 段数不齐：缺位视为 0
    // ---------------------------------------------------------------

    @Test
    fun `段数不齐时缺位视为 0`() {
        assertFalse(AppUpdater.isNewer("1.2", "1.2.0"))
        assertFalse(AppUpdater.isNewer("1.2.0", "1.2"))
        // "1.2" 与 "1.2.0.0" 同理
        assertFalse(AppUpdater.isNewer("1.2.0.0", "1.2"))
        // 但只要有一位真的更高，仍要判出新版本
        assertTrue(AppUpdater.isNewer("1.2.1", "1.2"))
        assertTrue(AppUpdater.isNewer("1.3", "1.2.9"))
    }

    // ---------------------------------------------------------------
    // 容错：空串 / 非数字段 / 脏数据，都不能抛
    // ---------------------------------------------------------------

    @Test
    fun `空串与空白容错`() {
        assertFalse(AppUpdater.isNewer("", ""))
        assertFalse(AppUpdater.isNewer("   ", "0"))
        // 本机版本意外为空时（视作 0），任何正常版本都算更新 —— 不能反而判成"没有更新"
        assertTrue(AppUpdater.isNewer("1.0.0", ""))
        assertTrue(AppUpdater.isNewer("0.0.1", ""))
        // 服务端给了空白版本号 = 没给，不该提示更新
        assertFalse(AppUpdater.isNewer("", "1.0.0"))
    }

    @Test
    fun `中文与特殊字符段按字符串比较且不抛异常`() {
        // 非数字段：只要求稳定、不崩，不要求"语义正确"
        assertFalse(AppUpdater.isNewer("测试", "测试"))
        assertTrue(AppUpdater.isNewer("测试2", "测试1"))
        assertTrue(AppUpdater.isNewer("b", "a"))
        assertFalse(AppUpdater.isNewer("a", "b"))
    }

    @Test
    fun `预发布后缀不会因为数字部分相同而误判`() {
        // patch 段 "3-beta" vs "3" 不是纯数字 → 走字符串比较。
        // 这个方向（本机带后缀、服务端不带）会提示更新：
        assertTrue(AppUpdater.isNewer("1.2.3-beta", "1.2.3"))
        // 反方向不提示 —— 正式版用户不会因为服务端配了预发布号而收到更新
        assertFalse(AppUpdater.isNewer("1.2.3", "1.2.3-beta"))
        // ⚠️ 上面两条**不对称**是字符串比较的固有性质（"3" < "3-beta"）。
        // 本项目服务端 APP_VERSION 只填正式版本号，不会走到这个分支；
        // 若将来真要支持预发布语义，得换成 SemVer 的预发布规则，而不是这里打补丁。
        assertTrue(AppUpdater.isNewer("1.3.0-beta", "1.2.9"))
        // 两个预发布号之间：后缀字符串比较，稳定即可
        assertTrue(AppUpdater.isNewer("1.2.3-rc2", "1.2.3-rc1"))
    }

    @Test
    fun `畸形空段与缺位一样按 0 处理`() {
        // 关键坑：`"".toLongOrNull()` 是 null 而不是 0，所以实现里必须显式归一化。
        // 少了这一步，`isNewer("1.2.0", "1.2")` 会返回 true（"" 与 "0" 落进字符串比较），
        // 表现为"服务端 1.2.0、本机 1.2 也弹更新"。
        assertFalse(AppUpdater.isNewer("1..0", "1.0.0"))
        assertTrue(AppUpdater.isNewer("1..1", "1.0.0"))
        // 注意 `1..1.0` 归一化后是 [1,0,1,0]，中间的空段是 0 ——
        // 它比 1.0.1 旧（第二位 0 < 0 之后第三位 1 > 1 相等、第四位 0 < 缺位 0 也相等）
        assertFalse(AppUpdater.isNewer("1..1.0", "1.0.1"))
        assertFalse(AppUpdater.isNewer("1.0.1", "1..1.0"))
        // 末尾空段相当于缺位
        assertFalse(AppUpdater.isNewer("1.0.", "1.0"))
        assertFalse(AppUpdater.isNewer("1.0", "1.0."))
    }

    @Test
    fun `数字前导零不影响比较`() {
        assertFalse(AppUpdater.isNewer("01.2", "1.2"))
        assertFalse(AppUpdater.isNewer("1.02.0", "1.2"))
        assertTrue(AppUpdater.isNewer("1.02.1", "1.2"))
    }

    @Test
    fun `前后空白被忽略`() {
        assertFalse(AppUpdater.isNewer(" 1.2.3 ", "1.2.3"))
        assertTrue(AppUpdater.isNewer(" 1.2.4 ", " 1.2.3 "))
    }

    @Test
    fun `真实场景 0_1_0 到 0_2_0`() {
        // 与本仓库 version.properties 的 versionName=0.1.0 对得上
        assertTrue(AppUpdater.isNewer("0.2.0", "0.1.0"))
        assertFalse(AppUpdater.isNewer("0.1.0", "0.1.0"))
        assertFalse(AppUpdater.isNewer("0.0.9", "0.1.0"))
    }
}
