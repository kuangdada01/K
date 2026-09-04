package com.k.app;

import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.appcompat.app.AppCompatDelegate;
import androidx.core.content.pm.PackageInfoCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewLocalServer;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "KTheme";

    private String currentThemeMode = "system";
    /** 全屏期望状态（语音房共享舞台等）：旋转/回前台后系统会恢复系统栏，需重新隐藏 */
    private boolean immersiveDesired = false;
    /** 全屏期间清零的各层顶部 margin/padding 原值（退出全屏时恢复） */
    private final java.util.HashMap<View, Integer> savedTopMargins = new java.util.HashMap<>();
    private final java.util.HashMap<View, Integer> savedTopPaddings = new java.util.HashMap<>();
    /** 沉浸期间被深色化的各层背景原值（退出时还原；系统栏隐藏动画/顶部间距清除的
        间隙瞬间，状态栏区域透出的是这些层的背景，浅色主题下为白色 = "状态栏变白"） */
    private final java.util.HashMap<View, android.graphics.drawable.Drawable> savedImmersiveBgs = new java.util.HashMap<>();
    /** JS 最近一次 setWindowBackgroundColor 的主题背景色（-1=从未设置）。
        退出沉浸时若视图链背景恢复为透明（透出黑色 windowBackground），用该色兜底。 */
    private int lastThemeBgColor = -1;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // 必须在 super.onCreate() 之前设置，让 AppCompat 自动处理系统夜间模式变化
        AppCompatDelegate.setDefaultNightMode(AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM);
        Log.d(TAG, ">>> onCreate START");
        super.onCreate(savedInstanceState);

        try {
            WebView webView = getBridge().getWebView();
            final Bridge bridge = getBridge();
            final WebViewLocalServer localServer = bridge.getLocalServer();

            Log.d(TAG, "  localServer=" + (localServer != null ? "OK" : "NULL"));

            webView.addJavascriptInterface(this, "AndroidBridge");

            webView.getSettings().setBuiltInZoomControls(false);
            webView.getSettings().setDisplayZoomControls(false);
            webView.getSettings().setSupportZoom(false);

            webView.setBackgroundColor(Color.TRANSPARENT);

            // 版本升级时清除 WebView 缓存：APK 升级后 WebView 会沿用旧的
            // index.html / CSS 缓存（hash 文件名只保证新资源不被旧页面引用，
            // 无法保证旧页面本身被替换），导致"代码已修复但 App 内还是旧样式"。
            clearCacheOnUpgrade();

            webView.setWebViewClient(new WebViewClient() {
                @Override
                public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                    WebResourceResponse resp = localServer.shouldInterceptRequest(request);
                    if (resp == null && request.isForMainFrame()) {
                        Log.w(TAG, "  shouldInterceptRequest: MAIN FRAME NOT INTERCEPTED! url=" + request.getUrl());
                    }
                    return resp;
                }

                @Override
                public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                    return bridge.launchIntent(request.getUrl());
                }

                @Override
                public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                    Log.e(TAG, "  onReceivedError: " + error.getDescription() + " url=" + request.getUrl());
                    super.onReceivedError(view, request, error);
                    String errorPath = bridge.getErrorUrl();
                    if (errorPath != null && request.isForMainFrame()) {
                        view.loadUrl(errorPath);
                    }
                }

                @Override
                public void onPageStarted(WebView view, String url, Bitmap favicon) {
                    super.onPageStarted(view, url, favicon);
                    Log.d(TAG, "  onPageStarted: " + url);
                }

                @Override
                public void onPageFinished(WebView view, String url) {
                    super.onPageFinished(view, url);
                    Log.d(TAG, "  onPageFinished: " + url + " (will apply theme in 500ms)");
                    // 首次应用透明状态栏，防止启动闪屏后透出系统默认底色
                    runOnUiThread(() -> ensureTransparentStatusBar());
                    new Handler(Looper.getMainLooper()).postDelayed(() -> {
                        Log.d(TAG, "  onPageFinished+500ms: applying theme from storage");
                        applyThemeFromStorage(view);
                    }, 500);
                }
            });
            Log.d(TAG, ">>> onCreate END (WebViewClient installed)");
        } catch (Exception e) {
            Log.e(TAG, ">>> onCreate ERROR", e);
            e.printStackTrace();
        }
    }

    /** 当前 App 版本号（versionCode） */
    private int getAppVersionCode() {
        try {
            if (Build.VERSION.SDK_INT >= 28) {
                return (int) PackageInfoCompat.getLongVersionCode(
                    getPackageManager().getPackageInfo(getPackageName(), 0));
            }
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionCode;
        } catch (Exception e) {
            Log.w(TAG, "getAppVersionCode failed", e);
            return 0;
        }
    }

    /**
     * 版本升级后清除 WebView 缓存（首次安装也会清）。
     * 只在版本号变化时执行一次，日常启动不清，兼顾加载速度。
     */
    private void clearCacheOnUpgrade() {
        try {
            int cur = getAppVersionCode();
            if (cur <= 0) return;
            android.content.SharedPreferences prefs =
                getSharedPreferences("k_app", android.content.Context.MODE_PRIVATE);
            int last = prefs.getInt("last_version_code", 0);
            if (last != cur) {
                Log.d(TAG, "  version " + last + " -> " + cur + ", clearing WebView cache");
                WebView wv = getBridge().getWebView();
                wv.clearCache(true);
                prefs.edit().putInt("last_version_code", cur).apply();
            }
        } catch (Exception e) {
            Log.w(TAG, "clearCacheOnUpgrade failed", e);
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        Log.d(TAG, ">>> onResume: re-applying theme");
        try {
            WebView webView = getBridge().getWebView();
            applyThemeFromStorage(webView);
            applyImmersiveMode(); // 全屏期望下回前台后系统栏可能被系统恢复，重新隐藏
        } catch (Exception e) {
            Log.d(TAG, ">>> onResume ERROR", e);
        }
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        Log.d(TAG, ">>> onConfigurationChanged: uiMode=" + (newConfig.uiMode & Configuration.UI_MODE_NIGHT_MASK));
        // 延迟到下帧覆盖系统 edge-to-edge 自动检测，所有模式都重新确保
        getWindow().getDecorView().postDelayed(() -> {
            boolean isDark = resolveIsDark(currentThemeMode);
            applyStatusBarAppearance(isDark);
            applyImmersiveMode();
            Log.d(TAG, "    ★ onConfigChanged reapplied: mode=" + currentThemeMode + " isDark=" + isDark);
        }, 100);
    }

    /**
     * 确保状态栏透明（API < 35 需要手动设置；API 35+ edge-to-edge 系统默认透明）
     */
    private void ensureTransparentStatusBar() {
        Window window = getWindow();
        if (Build.VERSION.SDK_INT < 35) {
            window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
            window.setStatusBarColor(Color.TRANSPARENT);
            int uiOptions = window.getDecorView().getSystemUiVisibility();
            uiOptions |= View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN;
            window.getDecorView().setSystemUiVisibility(uiOptions);
        }
    }

    /**
     * 设置状态栏图标颜色（双 API 确保 API 36 edge-to-edge 兼容）
     */
    private void applyStatusBarAppearance(boolean isDark) {
        Window window = getWindow();
        View decorView = window.getDecorView();

        WindowInsetsControllerCompat compatController =
            WindowCompat.getInsetsController(window, decorView);
        compatController.setAppearanceLightStatusBars(!isDark);

        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController nativeController = window.getInsetsController();
            if (nativeController != null) {
                int appearance = isDark ? 0 : WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS;
                nativeController.setSystemBarsAppearance(
                    appearance,
                    WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                );
            }
        }

        Log.d(TAG, "    ★ applyStatusBarAppearance: isDark=" + isDark + " lightStatusBars=" + !isDark);
    }

    /**
     * 解析模式字符串 → 是否为深色主题
     */
    private boolean resolveIsDark(String mode) {
        if ("system".equals(mode)) {
            int nightMode = getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
            return nightMode == Configuration.UI_MODE_NIGHT_YES;
        }
        return "dark".equals(mode);
    }

    /**
     * 从 localStorage 读取主题并应用到状态栏图标颜色
     */
    private void applyThemeFromStorage(WebView webView) {
        Log.d(TAG, "    applyThemeFromStorage: evaluating JS to read localStorage");
        webView.evaluateJavascript(
            "(function() { return localStorage.getItem('theme') || 'system'; })()",
            value -> {
                Log.d(TAG, "    localStorage theme value: " + value);
                String mode = value != null ? value.replace("\"", "") : "system";
                setAppThemeMode(mode);
            }
        );
    }

    /**
     * JS 接口：设置状态栏透明 + 根据主题模式设置图标颜色
     */
    @JavascriptInterface
    public void setAppThemeMode(String mode) {
        if (mode == null || !("light".equals(mode) || "dark".equals(mode) || "system".equals(mode))) {
            mode = "system";
        }
        Log.d(TAG, "    ★ setAppThemeMode: " + mode);
        currentThemeMode = mode;
        final String finalMode = mode;
        runOnUiThread(() -> {
            try {
                ensureTransparentStatusBar();
                boolean isDark = resolveIsDark(finalMode);
                applyStatusBarAppearance(isDark);
                Log.d(TAG, "    ★ setAppThemeMode done: mode=" + finalMode + " isDark=" + isDark);
                getWindow().getDecorView().postDelayed(() -> {
                    applyStatusBarAppearance(isDark);
                    Log.d(TAG, "    ★ setAppThemeMode reapply: isDark=" + isDark);
                }, 200);
            } catch (Exception e) {
                Log.e(TAG, "    ★ setAppThemeMode ERROR", e);
            }
        });
    }

    /**
     * JS 接口：使用 Capacitor Bridge 原生方法重新加载 WebView
     */
    @JavascriptInterface
    public void reloadApp() {
        Log.d(TAG, "    ★ reloadApp called from JS");
        runOnUiThread(() -> {
            try {
                Log.d(TAG, "    ★ calling bridge.reload(), appUrl=" + getBridge().getAppUrl());
                getBridge().getWebView().loadUrl(getBridge().getAppUrl());
            } catch (Exception e) {
                Log.e(TAG, "    ★ reloadApp ERROR", e);
                e.printStackTrace();
            }
        });
    }

    /**
     * JS 接口：沉浸模式（隐藏状态栏+导航栏，下滑临时呼出）。
     * WebView 里 requestFullscreen 不会隐藏系统栏（浏览器会），网页全屏时由 JS 调用；
     * 旋转 / 回前台后系统恢复系统栏，onResume 与 onConfigurationChanged 会重新应用。
     */
    @JavascriptInterface
    public void setImmersiveMode(final boolean enabled) {
        Log.d(TAG, "    setImmersiveMode: " + enabled);
        immersiveDesired = enabled;
        runOnUiThread(() -> applyImmersiveMode());
    }

    private void applyImmersiveMode() {
        try {
            // 统一走 androidx WindowInsetsControllerCompat（minSdk 24 兼容；targetSdk 36
            // 强制 edge-to-edge 下行为一致），替代直接调原生 WindowInsetsController
            WindowInsetsControllerCompat compat =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
            if (compat != null) {
                if (immersiveDesired) {
                    compat.setSystemBarsBehavior(
                        WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                    compat.hide(WindowInsetsCompat.Type.systemBars());
                } else {
                    compat.show(WindowInsetsCompat.Type.systemBars());
                    // ★ 退出全屏：show 系统栏后，insets 分发动画过程中 frame 背景
                    // 经常被系统短暂重置（hide 路径已有对称的二次隐藏兜底），导致
                    // 状态栏位置透出 windowBackground 黑底（用户反馈"退出后状态栏变黑"
                    // 的根因）。这里二次重新应用主题背景 + 兜底恢复沉浸保存的中间层。
                    final int themeBg = lastThemeBgColor;
                    if (themeBg != -1) {
                        getWindow().getDecorView().postDelayed(() -> {
                            try {
                                Log.d(TAG, "    re-apply theme bg after show systemBars");
                                applyBackgroundColorRecursive(getWindow().getDecorView(), themeBg);
                            } catch (Exception e) {
                                Log.w(TAG, "    reapply theme bg failed", e);
                            }
                        }, 150);
                    }
                }
            }
            // hide 后系统可能在 insets 分发/动画过程中恢复系统栏（edge-to-edge 强制
            // 模式下更常见），延迟再隐藏一次兜底；退出全屏时不延迟（避免闪一下）
            if (immersiveDesired) {
                getWindow().getDecorView().postDelayed(() -> {
                    WindowInsetsControllerCompat c2 =
                        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
                    if (c2 != null) {
                        c2.setSystemBarsBehavior(
                            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                        c2.hide(WindowInsetsCompat.Type.systemBars());
                    }
                }, 150);
            }
            // 沉浸期间把 WebView→根 整条链背景深色化：必须先于顶部间距清除执行，
            // 这样系统栏隐藏动画/间距清除的间隙瞬间，状态栏区域透出的是深色而非
            // 浅色主题的白色（首次进全屏"状态栏变白"的直接来源）
            applyImmersiveBackground(immersiveDesired);
            // 清掉 WebView 到根之间各层为状态栏预留的顶部 margin/padding，
            // 让页面真正全屏（退出时按记录恢复）。哪些层带间距随 Capacitor
            // 版本/设备而异，因此整条链路统一处理。
            WebView webView = getBridge().getWebView();
            applyTopInsetClear(webView);
            ViewParent cursor = webView.getParent();
            int depth = 0;
            while (cursor instanceof View && depth < 8) {
                View v = (View) cursor;
                applyTopInsetClear(v);
                cursor = v.getParent();
                depth++;
            }
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    /** 沉浸期间 WebView→根 整条视图链背景设为纯黑（#000，与 web 端全屏背景一致），退出时按记录还原。
     *  仅管理"各层自身背景"，与 JS 的 setWindowBackgroundColor（非 WebView 层主题色）
     *  互不冲突：沉浸时深色盖住一切间隙，退出后恢复原值由 JS 主题色接管。 */
    private void applyImmersiveBackground(boolean immersive) {
        try {
            WebView wv = getBridge().getWebView();
            java.util.List<View> chain = new java.util.ArrayList<>();
            chain.add(wv);
            ViewParent p = wv.getParent();
            int depth = 0;
            while (p instanceof View && depth < 8) {
                chain.add((View) p);
                p = p.getParent();
                depth++;
            }
            for (View v : chain) {
                if (immersive) {
                    if (!savedImmersiveBgs.containsKey(v)) {
                        savedImmersiveBgs.put(v, v.getBackground());
                    }
                    v.setBackgroundColor(Color.parseColor("#000000"));
                } else if (savedImmersiveBgs.containsKey(v)) {
                    v.setBackground(savedImmersiveBgs.remove(v));
                }
            }
            // 退出兜底：恢复后若 chain 上任一层背景为透明（原值为 null / saved 异常），
            // 状态栏/导航栏区域会透出下方 view 直至 windowBackground 黑底——
            // 这是用户看到的"退出后状态栏黑"。补做：DecorView + chain 每层，
            // 背景为 null 时直接用最近一次主题背景色兜底。
            if (!immersive && lastThemeBgColor != -1) {
                final int themeBg = lastThemeBgColor;
                View decor = getWindow().getDecorView();
                if (decor.getBackground() == null) {
                    decor.setBackgroundColor(themeBg);
                    Log.d(TAG, "    decor bg=null → applied themeBg");
                }
                for (View v : chain) {
                    if (v.getBackground() == null) {
                        v.setBackgroundColor(themeBg);
                        Log.d(TAG, "    chain view bg=null → applied themeBg: "
                            + v.getClass().getSimpleName());
                    }
                }
            }
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    private void applyTopInsetClear(View v) {
        ViewGroup.LayoutParams lp = v.getLayoutParams();
        if (lp instanceof ViewGroup.MarginLayoutParams) {
            ViewGroup.MarginLayoutParams mlp = (ViewGroup.MarginLayoutParams) lp;
            if (immersiveDesired) {
                if (!savedTopMargins.containsKey(v)) savedTopMargins.put(v, mlp.topMargin);
                if (mlp.topMargin != 0) {
                    Log.d(TAG, "    clear topMargin " + mlp.topMargin + " on " + v.getClass().getSimpleName());
                    mlp.topMargin = 0;
                    v.setLayoutParams(lp);
                }
            } else if (savedTopMargins.containsKey(v)) {
                int orig = savedTopMargins.remove(v);
                if (mlp.topMargin != orig) {
                    Log.d(TAG, "    restore topMargin " + orig + " on " + v.getClass().getSimpleName());
                    mlp.topMargin = orig;
                    v.setLayoutParams(lp);
                }
            }
        }
        int pt = v.getPaddingTop();
        if (immersiveDesired) {
            if (!savedTopPaddings.containsKey(v)) savedTopPaddings.put(v, pt);
            if (pt != 0) {
                Log.d(TAG, "    clear paddingTop " + pt + " on " + v.getClass().getSimpleName());
                v.setPadding(v.getPaddingLeft(), 0, v.getPaddingRight(), v.getPaddingBottom());
            }
        } else if (savedTopPaddings.containsKey(v)) {
            int orig = savedTopPaddings.remove(v);
            if (pt != orig) {
                Log.d(TAG, "    restore paddingTop " + orig + " on " + v.getClass().getSimpleName());
                v.setPadding(v.getPaddingLeft(), orig, v.getPaddingRight(), v.getPaddingBottom());
            }
        }
    }

    /**
     * JS 接口：设置 DecorView 背景色
     */
    @JavascriptInterface
    public void setWindowBackgroundColor(String hexColor) {
        Log.d(TAG, "    setWindowBackgroundColor: " + hexColor);
        runOnUiThread(() -> {
            try {
                int color = Color.parseColor(hexColor);
                lastThemeBgColor = color; // 记录主题背景色：退出沉浸模式时兜底用
                // Android 16 强制 edge-to-edge 时，状态栏条透出的是 WebView 容器
                // （全屏 ViewGroup）的主题背景色，只设 DecorView 会被它盖住，
                // 必须递归覆盖所有非 WebView 容器层
                applyBackgroundColorRecursive(getWindow().getDecorView(), color);
            } catch (Exception e) {
                e.printStackTrace();
            }
        });
    }

    /** 递归给除 WebView 外的所有视图层设置背景色（页面全部内容都在 WebView 内，安全） */
    private void applyBackgroundColorRecursive(View v, int color) {
        if (v instanceof WebView) return;
        v.setBackgroundColor(color);
        if (v instanceof ViewGroup) {
            ViewGroup g = (ViewGroup) v;
            for (int i = 0; i < g.getChildCount(); i++) {
                applyBackgroundColorRecursive(g.getChildAt(i), color);
            }
        }
    }
}
