# Capacitor ProGuard rules
-keep class com.getcapacitor.** { *; }
-keep class com.capacitorjs.** { *; }
-keep class org.apache.cordova.** { *; }
-keep class androidx.** { *; }

# 自定义原生插件：JS 按方法名分发（Capacitor 用 @PluginMethod/@ActivityCallback
# 反射建表），方法名被混淆会变成「debug 正常、release 调用无效」。
# Capacitor AAR 的 consumer 规则理论上已覆盖，这里再显式钉一次。
-keep class com.k.app.NativeImageViewerPlugin { *; }

# Keep JavaScript interface
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Keep source file info for crash reports
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# OkHttp
-dontwarn okhttp3.**
-dontwarn okio.**
-keep class okhttp3.** { *; }
-keep class okio.** { *; }

# Gson
-keep class com.google.gson.** { *; }
-keepattributes Signature
-keepattributes *Annotation*
