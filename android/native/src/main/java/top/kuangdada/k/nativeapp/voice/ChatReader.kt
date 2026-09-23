package top.kuangdada.k.nativeapp.voice

import android.content.Context
import android.speech.tts.TextToSpeech
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import java.util.Locale

/**
 * ============================================================
 * 房间聊天「朗读」（设计稿：文字聊天右上角的朗读开关）
 * ============================================================
 * 与 Web 端的 `useChatTTS` 同一语义：**开着的时候，把新收到的消息念出来**，
 * 念的格式是「某某说：内容」（Web 端注释里写的就是"格式「用户名说内容」"）。
 *
 * 三个必须处理对的点（错一个就是"点了没反应"或"退出房间还在念"）：
 *
 *  1. **Android 11+ 的包可见性**：要绑定系统 TTS 引擎，清单里必须有
 *     `<queries><intent><action android:name="android.intent.action.TTS_SERVICE"/></intent></queries>`
 *     （见 `AndroidManifest.xml`）。漏了不会报错，`TextToSpeech` 只是**静默初始化失败** ——
 *     这正是"朗读点了没反应"最常见的原因。这里的 [supported] 就是用它兜底告诉用户。
 *  2. **生命周期**：TTS 引擎是系统服务连接，必须在离开页面时 `shutdown()`，
 *     否则退出房间后它还在念（而且引擎连接一直挂着）。
 *  3. **自己发的消息不念**：念自己刚打完的字很怪；Web 端也只念"收到的"。
 *
 * 注：Android 没有"朗读是否开启"的持久化要求 —— 与 Web 端一样，**一次进房一次选择**，
 * 默认关闭（默认开会让每个进房的人突然听到机器音）。
 */
class ChatReader internal constructor(private val context: Context) {

    private var tts: TextToSpeech? = null

    /** 引擎是否可用（初始化成功且语言数据就绪）。false 时 UI 把开关置灰 */
    var supported by mutableStateOf(false)
        private set

    /** 朗读开关（用户点右上角那个按钮切） */
    var enabled by mutableStateOf(false)
        private set

    internal fun init() {
        if (tts != null) return
        tts = TextToSpeech(context.applicationContext) { status ->
            val engine = tts
            if (status == TextToSpeech.SUCCESS && engine != null) {
                // 中文优先；没有中文数据就退回系统默认语言（英文消息也能念）
                val zh = runCatching { engine.setLanguage(Locale.CHINESE) }.getOrDefault(-1)
                if (zh == TextToSpeech.LANG_MISSING_DATA || zh == TextToSpeech.LANG_NOT_SUPPORTED) {
                    runCatching { engine.setLanguage(Locale.getDefault()) }
                }
                supported = true
            } else {
                supported = false
            }
        }
    }

    fun toggle() {
        if (!supported) return
        enabled = !enabled
        if (!enabled) runCatching { tts?.stop() }
    }

    /** 念一条消息。格式与 Web 端一致：「用户名说内容」 */
    fun speak(username: String, content: String) {
        if (!enabled || !supported) return
        val text = "$username 说 $content"
        runCatching { tts?.speak(text, TextToSpeech.QUEUE_ADD, null, "k-chat-${text.hashCode()}") }
    }

    internal fun release() {
        runCatching { tts?.stop() }
        runCatching { tts?.shutdown() }
        tts = null
        supported = false
        enabled = false
    }
}

/**
 * 取得（并托管）当前页面的朗读器：进页面时初始化，离开页面时关掉引擎。
 *
 * 不在 Composable 里直接 new：TTS 的初始化是**异步**的（回调里才知道能不能用），
 * 所以 `supported` 是状态，UI 会跟着它把开关从置灰变成可点。
 */
@Composable
fun rememberChatReader(): ChatReader {
    val context = LocalContext.current
    val reader = remember(context) { ChatReader(context) }
    DisposableEffect(reader) {
        reader.init()
        onDispose { reader.release() }
    }
    return reader
}
