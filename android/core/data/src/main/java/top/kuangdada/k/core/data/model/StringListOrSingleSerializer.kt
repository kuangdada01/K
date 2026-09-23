package top.kuangdada.k.core.data.model

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonPrimitive

/**
 * ============================================================
 * `urls` 字段的兼容序列化器：**数组或单个字符串都接受**
 * ============================================================
 * 为什么需要它：服务端 `/api/voice/ice` 实际返回的形状**两种混用**——
 * ```json
 * {"iceServers":[
 *    {"urls":["stun:stun.qq.com:3478","stun:stun.miwifi.com:3478"]},   // 数组
 *    {"urls":"turn:120.25.100.193:3478","username":"…","credential":"…"} // 字符串
 * ]}
 * ```
 * 这是符合 WebRTC `RTCIceServer.urls` 规范的（规范里就是 `string | string[]`），
 * 但**只按 `List<String>` 解会在第二条上抛 `SerializationException`** ——
 * 真机上的表现是"房间提示：获取配置失败：服务端返回的数据格式异常"，
 * 而信令、鉴权、其他接口全都正常，很容易被误判成网络问题。
 *
 * 服务端不改（Web 版按规范消费这个字段没有问题），所以在 DTO 层做兼容归一化：
 * 单字符串 → 单元素数组。
 *
 * 注意这里只实现**反序列化**：我们只消费这个字段，从不回传。
 */
internal object StringListOrSingleSerializer : KSerializer<List<String>> {

    override val descriptor: SerialDescriptor =
        buildClassSerialDescriptor("StringListOrSingle")

    override fun deserialize(decoder: Decoder): List<String> {
        // 必须能拿到 JSON 元素本身（而不是走 default 的「按 List 解」路径），
        // 否则单字符串形态会解成空列表 —— 那样"解析成功但配置为空"，
        // 表现为"没有 TURN 可用"，是最难查的那种静默失效。
        val input = decoder as? JsonDecoder
            ?: throw SerializationException("urls 字段需要 JSON 输入（实际为 ${decoder::class.simpleName}）")
        return when (val element = input.decodeJsonElement()) {
            is JsonArray -> element.mapNotNull { (it as? JsonPrimitive)?.content?.takeIf(String::isNotBlank) }
            is JsonPrimitive -> listOfNotNull(element.content.takeIf(String::isNotBlank))
            // 既不是数组也不是字符串 —— 直接报错。
            // 宁可让整次调用失败并显示"数据格式异常"（用户能立刻反馈、我们也看得到），
            // 也不要静默产出一个空的 ICE 配置（表现成"连不上但没有任何错误提示"）。
            else -> throw SerializationException("urls 字段既不是字符串也不是数组：$element")
        }
    }

    override fun serialize(encoder: Encoder, value: List<String>) {
        // 契约上我们只读不写；真需要写时按数组形态（WebRTC 规范推荐形态）
        encoder.encodeSerializableValue(ListSerializer(String.serializer()), value)
    }
}
