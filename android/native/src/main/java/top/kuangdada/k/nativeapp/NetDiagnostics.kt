package top.kuangdada.k.nativeapp

import android.util.Log
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket

/**
 * ============================================================
 * 临时网络诊断（排查"语音房双方都听不到"用）
 * ============================================================
 * 为什么必须在**应用进程内**跑：`adb shell ping` 是 shell 用户、
 * 走的是系统默认网络；而 WebRTC 的 socket 属于本应用 uid，
 * 受 VPN 路由/uid 规则影响。两者结论可能完全相反，所以不能拿 shell 的
 * 结果推断应用能不能连通。
 *
 * 触发方式（不会自动跑）：
 * ```
 * adb shell am start -n <pkg>/top.kuangdada.k.nativeapp.MainActivity -a top.kuangdada.k.nativeapp.NETTEST
 * ```
 * 结果全部打在 `KNetTest` 标签下。排查完即删，不属于产品功能。
 */
internal object NetDiagnostics {

    private const val TAG = "KNetTest"

    fun run(host: String = "120.25.100.193", port: Int = 3478) {
        Thread {
            Log.e(TAG, "===== 开始：目标 $host:$port =====")
            udpSend(host, port)
            // WebRTC 是按网卡逐条发 STUN 的：绑定到该网卡的地址再发一次。
            // 这一步才是和 WebRTC 处境一致的那个测试。
            udpSendBound(host, port, "192.168.5.4")   // wlan0
            udpSendBound(host, port, "172.30.226.5")  // vgate0 (VPN)
            tcpConnect(host, port)
            tcpConnect("www.kuangdada.top", 443)
            Log.e(TAG, "===== 结束 =====")
        }.start()
    }

    /** 绑定到指定本机地址后发同一个 STUN 请求（等价于 WebRTC 的 per-interface 行为） */
    private fun udpSendBound(host: String, port: Int, localIp: String) {
        var socket: DatagramSocket? = null
        try {
            socket = DatagramSocket(null).apply {
                reuseAddress = true
                bind(InetSocketAddress(localIp, 0))
                soTimeout = 5000
            }
            val packet = DatagramPacket(STUN_BINDING, STUN_BINDING.size, InetAddress.getByName(host), port)
            val start = System.currentTimeMillis()
            socket.send(packet)
            val buf = ByteArray(1500)
            val reply = DatagramPacket(buf, buf.size)
            socket.receive(reply)
            Log.e(TAG, "UDPb [$localIp] ✅ 收到 ${reply.length} 字节，${System.currentTimeMillis() - start}ms")
        } catch (t: Throwable) {
            Log.e(TAG, "UDPb [$localIp] ❌ ${t.javaClass.simpleName}: ${t.message}")
        } finally {
            runCatching { socket?.close() }
        }
    }

    /** 发一个最小 STUN Binding Request（20 字节头即可，不需要合法事务 id） */
    private fun udpSend(host: String, port: Int) {
        var socket: DatagramSocket? = null
        try {
            socket = DatagramSocket().apply { soTimeout = 5000 }
            val address = InetAddress.getByName(host)
            val packet = DatagramPacket(STUN_BINDING, STUN_BINDING.size, address, port)
            val start = System.currentTimeMillis()
            socket.send(packet)

            val buf = ByteArray(1500)
            val reply = DatagramPacket(buf, buf.size)
            socket.receive(reply)
            Log.e(
                TAG,
                "UDP  $host:$port  ✅ 收到 ${reply.length} 字节，${System.currentTimeMillis() - start}ms " +
                    "（本端 socket=${socket.localAddress}:${socket.localPort}）"
            )
        } catch (t: Throwable) {
            Log.e(TAG, "UDP  $host:$port  ❌ ${t.javaClass.simpleName}: ${t.message}")
        } finally {
            runCatching { socket?.close() }
        }
    }

    private fun tcpConnect(host: String, port: Int) {
        val start = System.currentTimeMillis()
        try {
            Socket().use { s ->
                s.connect(InetSocketAddress(host, port), 5000)
                Log.e(
                    TAG,
                    "TCP  $host:$port  ✅ 已连接，${System.currentTimeMillis() - start}ms " +
                        "（本端=${s.localAddress}:${s.localPort}）"
                )
            }
        } catch (t: Throwable) {
            Log.e(TAG, "TCP  $host:$port  ❌ ${t.javaClass.simpleName}: ${t.message}")
        }
    }

    private val STUN_BINDING: ByteArray = byteArrayOf(
        0x00, 0x01, 0x00, 0x00, // Binding Request, length 0
        0x21, 0x12, 0xA4.toByte(), 0x42, // magic cookie
        0x4B, 0x4E, 0x65, 0x74, // transaction id (12 bytes)
        0x54, 0x65, 0x73, 0x74,
        0x30, 0x30, 0x30, 0x31,
    )
}
