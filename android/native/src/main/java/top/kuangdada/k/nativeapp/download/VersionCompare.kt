package top.kuangdada.k.nativeapp.download

/**
 * ============================================================
 * 版本号比较（纯 Kotlin，**刻意不依赖任何 Android API**）
 * ============================================================
 * 为什么单独拆一个 object 而不是塞在 `AppUpdater` 里：
 * `AppUpdater` 的构造器会碰 `Context` / `AppGraph`，在 JVM 单测里没法直接实例化
 * （要么起 Robolectric，要么挂 android.jar 桩）。把纯逻辑拆出来后，
 * 单测可以直接对 [VersionCompare.isNewer] 断言，不需要任何 Android 环境。
 *
 * 规则（来自"服务端版本号 vs BuildConfig.VERSION_NAME"的实际需求）：
 *  · 按 `.` 分段比较；
 *  · **两边都是纯数字就按数值比** —— 关键：字符串比较下 `1.10.0 < 1.9.0`，
 *    会让 1.10.0 的用户永远收不到更新；顺带去掉前导零，`01.2` == `1.2`；
 *  · 非数字段（`1.2.3-beta` 的 `3-beta`）按字符串比较，保证稳定排序；
 *  · 段数不齐时**缺位视为 0**（`1.2` == `1.2.0`）；
 *  · 空串/空白段一律当 0，绝不抛异常 —— 这个值来自服务端配置，脏数据不能崩掉检测。
 */
object VersionCompare {

    /**
     * 服务端版本 [remote] 是否比本机版本 [local] 新（即应该提示更新）。
     *
     * `1.2.3` vs `1.2.3` → false；`1.2.4` vs `1.2.3` → true；
     * `1.10.0` vs `1.9.0` → **true**（字符串比较会得到 false）。
     */
    fun isNewer(remote: String, local: String): Boolean = compare(remote, local) > 0

    /**
     * @return >0 表示 [remote] 比 [local] 新，0 表示相等（缺位按 0 补齐）
     */
    fun compare(remote: String, local: String): Int {
        val a = splitSegments(remote)
        val b = splitSegments(local)
        val size = maxOf(a.size, b.size)
        for (i in 0 until size) {
            // 缺位补 ""，由 normalizeSegment 归一成 "0"
            val cmp = compareSegment(a.getOrElse(i) { "" }, b.getOrElse(i) { "" })
            if (cmp != 0) return cmp
        }
        return 0
    }

    /**
     * 段归一化。
     *
     * ⚠️ 这里踩过一个坑，别再踩：**`"".toLongOrNull()` 返回 null，不是 0**。
     * 所以"缺位视为 0"**不会**被 `toLongOrNull` 自动完成 —— 首版就栽在这儿：
     * `isNewer("1.2.0", "1.2")` 返回了 true（缺位段 `""` 与 `"0"` 落进字符串比较），
     * 表现为"服务端 1.2.0、本机 1.2 也会弹一次假更新"。必须先显式归一化。
     *
     * 只对"空/纯数字"的段生效：`1.2.3-beta` 这类段原样保留走字符串比较，
     * 不会因为含数字就被改写。
     */
    private fun normalizeSegment(raw: String): String {
        val t = raw.trim()
        if (t.isEmpty()) return "0"
        return if (t.all { it.isDigit() }) t.trimStart('0').ifEmpty { "0" } else t
    }

    /**
     * `toLongOrNull` 而不是 `toIntOrNull`：版本号里塞了超长数字时 Int 会溢出，
     * Long 也不够长时返回 null 自动退回字符串比较，行为仍然确定（不抛异常）。
     */
    private fun compareSegment(left: String, right: String): Int {
        val l = normalizeSegment(left)
        val r = normalizeSegment(right)
        val ln = l.toLongOrNull()
        val rn = r.toLongOrNull()
        return if (ln != null && rn != null) ln.compareTo(rn) else l.compareTo(r)
    }

    private fun splitSegments(version: String): List<String> = version.trim().split('.')
}
