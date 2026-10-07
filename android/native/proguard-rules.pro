# 原生版（:native）R8 规则
#
# Compose 的绝大部分规则由 AGP 自带的 consumer rules 提供，这里只保留本项目特有的：
# 后续接入 Retrofit / kotlinx.serialization / WebRTC 时它们的 consumer rules 也会自动合并。

# 保留行号，便于线上崩溃栈定位（体积影响可忽略）
-keepattributes SourceFile,LineNumberTable

# ---------------------------------------------------------------------------
# Retrofit + kotlinx.serialization（KApi 里所有接口都是 retrofit.create 反射建的）
# ---------------------------------------------------------------------------
# 库自带的 consumer rules 理论上够用，但真机上出现过 KApp 启动即 ClassCastException
# （栈落在 kotlinx 序列化转换器的 <init> 里，R8 混淆栈无法直接定位）——
# 显式把这几类东西钉死：接口的泛型签名、Retrofit 注解方法、@Serializable 生成的序列化器。
# 多余的 keep 只影响体积，不影响正确性。
-keepattributes Signature, InnerClasses, EnclosingMethod, AnnotationDefault

# ⚠️ 关键：**服务接口绝不能被 shrink**（这里刻意不写 allowshrinking）。
# `allowshrinking` 会允许 R8 做「接口合并」（class merging）：接口被并进另一个接口后，
# `retrofit.create(EventApi::class.java)` 里的 `EventApi::class.java` 会被改写成合并后的接口，
# 而返回值到 `EventApi` 的 checkcast 被 R8 换成合成类
# `...$$ExternalSyntheticThrowCCEIfNotNull0` 里的「必抛 CCE」——
# 表现就是 **debug 正常、release 一启动就闪退**：KApp.onCreate → KApi.<init>:85
# 抛 `java.lang.ClassCastException`，栈里只有 `R8$$SyntheticClass`，没有任何业务线索。
# 动态代理是 create() 运行期反射生成的，R8 静态分析看不到这个实现，
# 因此这些接口的**类型身份必须保留**（保留接口本身，允许方法级优化）。
-keep,allowobfuscation interface * {
    @retrofit2.http.* <methods>;
}
# 本项目自己的服务接口：整个接口钉死（方法也保留），彻底杜绝被合并的可能。
-keep interface top.kuangdada.k.core.data.api.** { *; }
-dontnote kotlinx.serialization.**
-dontwarn kotlinx.serialization.**
-keep,includedescriptorclasses class top.kuangdada.k.core.data.model.**$$serializer { *; }
-keepclassmembers class top.kuangdada.k.core.data.model.** {
    *** Companion;
}
-keepclasseswithmembers class top.kuangdada.k.core.data.model.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# ---------------------------------------------------------------------------
# WebRTC（语音房）—— 不 keep 的话**进语音房立刻 SIGTRAP**，栈里没有任何 Java 线索
# ---------------------------------------------------------------------------
# 症状（release/混淆包必现，debug 与 minifyEnabled=false 的包完全正常）：
#   点进语音房 → 进程直接没了，crash buffer 只有一行：
#     signal 5 (SIGTRAP), code 1 (TRAP_BRKPT)
#     #04 libjingle_peerconnection_so.so (JNI_OnLoad+64) … System.loadLibrary
# 即崩在 native 库的 **JNI_OnLoad** 里。
#
# 真正原因（2026-09 用 .so 反汇编 + R8 mapping/usage 三件套定位）：
#   1) JNI_OnLoad → webrtc::jni::InitGlobalJniVariables(jvm)（sdk/android/src/jni/jvm.cc）
#      → 进 jni_zero 的初始化（third_party/jni_zero/jni_zero.cc）
#      → `FindClass("org/jni_zero/JniInit")`；
#   2) `io.github.webrtc-sdk:android` 的 AAR 里带了 8 个 `org.jni_zero.*`
#      （JniInit + 7 个注解），**只有 native 代码按名字用它们**，Java 侧没人引用；
#   3) 没有 consumer proguard rules，R8 **shrink** 时把它们全删了
#      （`build/outputs/mapping/release/usage.txt` 里实锤 `org.jni_zero.JniInit-IA`）；
#   4) FindClass 返回 null → jni_zero 的 `Failed to find class %s` → FatalLog → `brk #0`（SIGTRAP）。
# 所以 `-keep class org.webrtc.**` 不够 —— **包名根本不在 org.webrtc 下**。
# 同理 `.so` 里所有 Java 类引用都必须是"字符串类名 + 成员名"原样保留：
# R8 改名/删除任何一项，native 侧都会在 JNI_OnLoad 里直接 trap。
-keep class org.webrtc.** { *; }
-dontwarn org.webrtc.**
# ⚠️ 关键：jni_zero 的运行时 bootstrap 类（缺一个就 SIGTRAP，见上面的排查过程）
-keep class org.jni_zero.** { *; }
-dontwarn org.jni_zero.**

# ---------------------------------------------------------------------------
# Tink（androidx.security:security-crypto 的传递依赖）
# ---------------------------------------------------------------------------
# 只缺**注解类**本身，不是真的缺功能代码。R8 在 release 全量构建时会报：
#   Missing class com.google.errorprone.annotations.RestrictedApi
#     (referenced from: com.google.crypto.tink.aead.AesEaxKey$Builder ...)
# 这类 errorprone 注解只在编译期存在、运行期不需要，不补规则的话 release 直接构建失败
# （debug 不跑 R8，所以这个坑只有首次打 release 包时才会暴露 —— 本项目的真实经历）。
-dontwarn com.google.errorprone.annotations.**
# 注解本身不参与运行，但 Tink 的部分类在注解里引用了它，保留注解可见性避免二次告警
-keepattributes RuntimeVisibleAnnotations,RuntimeInvisibleAnnotations
