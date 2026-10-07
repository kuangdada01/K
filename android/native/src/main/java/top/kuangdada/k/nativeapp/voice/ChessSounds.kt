package top.kuangdada.k.nativeapp.voice

import android.content.Context
import android.media.AudioAttributes
import android.media.SoundPool
import android.os.Handler
import android.os.Looper
import top.kuangdada.k.nativeapp.R

/**
 * 象棋音效（SoundPool，短样本低延迟，全部打进安装包本地即时播放）。
 *
 * · `res/raw/chess_move.mp3`      落子 —— Freesound #742356 "SingleKnock_Wood"（CC0），
 *   与 Web 端 classic 包同源（public/chess/sounds/）；
 * · `res/raw/chess_capture.m4a`   吃子 —— 用户自备音源 "man"（M4A/AAC，SoundPool 原生支持）；
 * · `res/raw/chess_check.m4a`     将军 —— 用户自备音源 "out"；
 * · `res/raw/chess_checkmate.m4a` 绝杀 —— 用户自备音源 "whatcan"。
 *
 * · [SoundPool.load] 是异步的：加载完成前播放会被静默忽略，用 [Sample.loaded] 按样本守卫
 *   （错过开局第一声无所谓，不能阻塞对局逻辑）。
 * · 未 [init]（面板没挂载过 / JVM 单测环境）一切播放调用静默跳过 —— 音效永远不能
 *   成为对局逻辑的崩溃点。
 * · [init] 幂等：面板挂载时调用即可，池子整个进程复用。
 * · 音量 0.85：语音房里要能听见、又不盖过说话声。
 */
object ChessSounds {
    private var pool: SoundPool? = null

    private class Sample(val resId: Int) {
        var soundId = 0
        var loaded = false
    }

    private var move: Sample? = null
    private var capture: Sample? = null
    private var check: Sample? = null
    private var checkmate: Sample? = null

    fun init(context: Context) {
        if (pool != null) return
        val attrs = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        val p = SoundPool.Builder()
            .setMaxStreams(3)
            .setAudioAttributes(attrs)
            .build()
        p.setOnLoadCompleteListener { _, id, status ->
            listOf(move, capture, check, checkmate).filterNotNull()
                .firstOrNull { it.soundId == id }
                ?.let { s -> if (status == 0) s.loaded = true }
        }
        fun load(sample: Sample, resId: Int): Sample {
            sample.soundId = p.load(context, resId, 1)
            return sample
        }
        move = load(Sample(R.raw.chess_move), R.raw.chess_move)
        capture = load(Sample(R.raw.chess_capture), R.raw.chess_capture)
        check = load(Sample(R.raw.chess_check), R.raw.chess_check)
        checkmate = load(Sample(R.raw.chess_checkmate), R.raw.chess_checkmate)
        pool = p
    }

    /** 落子（普通走子） */
    fun move() = play(move)

    /** 吃子（走子带 captured） */
    fun capture() = play(capture)

    /** 将军：走子音之后 200ms 补响（与 Web 端 setTimeout 的节奏一致，两个音不打架）。
     *  JVM 单测环境没有主线程 Looper（android.os 未 mock）→ 直接同步播，
     *  那里样本本就没加载，play 会静默跳过，不影响测试。 */
    fun check() {
        val mainLooper: Looper? = try {
            Looper.getMainLooper()
        } catch (_: Throwable) {
            null
        }
        if (mainLooper != null) {
            Handler(mainLooper).postDelayed({ play(check) }, 200)
        } else {
            play(check)
        }
    }

    /** 绝杀（对局以 checkmate 结束） */
    fun checkmate() = play(checkmate)

    private fun play(s: Sample?) {
        if (s == null || !s.loaded) return
        pool?.play(s.soundId, 0.85f, 0.85f, 1, 0, 1f)
    }
}
