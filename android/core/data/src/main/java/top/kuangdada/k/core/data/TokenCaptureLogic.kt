package top.kuangdada.k.core.data

/**
 * ============================================================
 * 续期 / 401 的代次判定逻辑（TokenCaptureLogic）
 * ============================================================
 * 从 [KApi] 的拦截器里抽出来的**纯逻辑**（不碰 OkHttp 类型，纯 JVM 可单测）。
 * 三个规则（P1-3.1 会话代次）：
 *
 *  1. **续期必须同代次**：请求发出时捕获的代次与当前不一致（期间发生过登出/换号），
 *     服务端回的新 token 一律丢弃 —— A 会话的迟到续期不得覆盖/复活 B 的凭证。
 *  2. **续期要求本地已有 token**：本地已清空说明当前没有会话，迟到的续期头
 *     不得把凭证凭空写回来（与 Web 端 storeRefreshedToken 的闸门一致）。
 *  3. **401 只转交同代次的请求**：回调带上发出时的代次，由会话层比对后决定
 *     是否标记失效 —— B 登录后 A 的过期 401 不得把 B 踢下线。
 *
 * 正常的滑动续期不换代会话（代次不变），不受影响。
 */
internal class TokenCaptureLogic(
    private val readToken: () -> String?,
    private val writeToken: (String) -> Unit,
    /** 当前会话代次（与各回调携带的“发出时代次”比对） */
    private val currentEpoch: () -> Int,
    private val onUnauthorized: (epochAtSend: Int) -> Unit,
) {

    /** 响应侧处理 X-Refreshed-Token（无该头传 null）。@return 是否真的落盘 */
    fun handleRefreshedToken(fresh: String?, epochAtSend: Int): Boolean {
        if (fresh.isNullOrEmpty()) return false
        if (epochAtSend != currentEpoch()) return false // 迟到的旧会话续期：丢弃
        val current = readToken() ?: return false // 本地无会话：不复活凭证
        if (fresh == current) return false
        writeToken(fresh)
        return true
    }

    /** 响应侧处理 401（仅同代次才转交会话层） */
    fun handleUnauthorizedIfMatches(responseCode: Int, epochAtSend: Int) {
        if (responseCode == 401 && epochAtSend == currentEpoch()) {
            onUnauthorized(epochAtSend)
        }
    }
}
