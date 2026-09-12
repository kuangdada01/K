package com.k.app;

import android.animation.ValueAnimator;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.os.Bundle;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.view.animation.DecelerateInterpolator;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.ProgressBar;
import android.widget.TextView;

import androidx.activity.OnBackPressedCallback;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.recyclerview.widget.RecyclerView;
import androidx.viewpager2.widget.ViewPager2;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.Map;

/**
 * ============================================================
 * 原生图片查看器（ImageViewerActivity）
 * ============================================================
 * 微信朋友圈/酷安/系统相册那一套：ViewPager2 翻页 + 原生缩放手势 +
 * 下拉关闭 + 从缩略图放大进入。跑在原生 UI 线程，不经过 WebView。
 *
 * 结构：FrameLayout(黑色底) > ViewPager2 + 计数 + 关闭按钮 + Hero 图层
 * - Hero：JS 传来被点缩略图的屏幕矩形，先把该图画在矩形位置，
 *   再动画到「等比铺满屏幕」的目标矩形，同时背景由透明渐入 ——
 *   这是「点开就是那张图长出来」的原生观感来源；
 *   若 hero 图未在极短时间内解码完成，退化为整体淡入（不阻塞打开）。
 * - 下拉关闭：1x 下纵向拖拽跟手位移 + 背景同步透明，松手超过阈值即关闭。
 * ============================================================
 */
public class ImageViewerActivity extends AppCompatActivity {

    public static final String EXTRA_IMAGES = "images";
    public static final String EXTRA_INDEX = "index";
    public static final String EXTRA_HEADERS = "headers";
    public static final String EXTRA_SRC_RECT = "srcRect";
    public static final String EXTRA_COLOR = "bgColor";
    public static final String RESULT_INDEX = "index";
    /** Hero 等待解码的上限（ms）：超过就退化为淡入，避免「点了没反应」 */
    private static final long HERO_TIMEOUT_MS = 180;

    private final android.os.Handler mainHandler = new android.os.Handler(android.os.Looper.getMainLooper());

    private ViewPager2 pager;
    private TextView counter;
    private View scrim;
    @Nullable
    private ImageView hero;
    private ArrayList<String> images = new ArrayList<>();
    private HashMap<String, String> headers = new HashMap<>();
    private int startIndex = 0;
    private int currentIndex = 0;
    private int[] srcRect; // [left, top, right, bottom]（屏幕 px）

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        applyFullscreenWindow();

        Intent intent = getIntent();
        ArrayList<String> list = intent.getStringArrayListExtra(EXTRA_IMAGES);
        if (list != null) images = list;
        startIndex = Math.max(0, Math.min(intent.getIntExtra(EXTRA_INDEX, 0), Math.max(0, images.size() - 1)));
        currentIndex = startIndex;
        Bundle hb = intent.getBundleExtra(EXTRA_HEADERS);
        if (hb != null) {
            for (String k : hb.keySet()) {
                String v = hb.getString(k);
                if (k != null && v != null) headers.put(k, v);
            }
        }
        int[] rect = intent.getIntArrayExtra(EXTRA_SRC_RECT);
        srcRect = (rect != null && rect.length == 4 && rect[2] > rect[0] && rect[3] > rect[1]) ? rect : null;

        setContentView(R.layout.activity_image_viewer);
        scrim = findViewById(R.id.viewer_scrim);
        pager = findViewById(R.id.viewer_pager);
        counter = findViewById(R.id.viewer_counter);
        View close = findViewById(R.id.viewer_close);
        close.setOnClickListener(v -> finish());

        pager.setAdapter(new PageAdapter());
        pager.setOffscreenPageLimit(1);
        pager.setCurrentItem(startIndex, false);
        pager.registerOnPageChangeCallback(new ViewPager2.OnPageChangeCallback() {
            @Override
            public void onPageSelected(int position) {
                currentIndex = position;
                updateCounter();
            }
        });
        updateCounter();
        registerBackHandling();

        // 打开动画：有缩略图矩形就做 Hero，否则淡入
        scrim.setAlpha(0f);
        if (srcRect != null && !images.isEmpty()) {
            playOpenHero();
        } else {
            scrim.animate().alpha(1f).setDuration(180).start();
        }
    }

    /** 全屏沉浸：状态栏/导航栏隐藏，窗口透明（Hero 需要能看到下层） */
    private void applyFullscreenWindow() {
        Window w = getWindow();
        w.setFlags(
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS);
        w.setStatusBarColor(Color.TRANSPARENT);
        w.setNavigationBarColor(Color.TRANSPARENT);
        WindowCompat.setDecorFitsSystemWindows(w, false);
        WindowInsetsControllerCompat c = WindowCompat.getInsetsController(w, w.getDecorView());
        if (c != null) {
            c.hide(WindowInsetsCompat.Type.systemBars());
            c.setSystemBarsBehavior(
                    WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        }
    }

    private void updateCounter() {
        if (images.size() > 1) {
            counter.setVisibility(View.VISIBLE);
            counter.setText(getString(R.string.viewer_counter, currentIndex + 1, images.size()));
        } else {
            counter.setVisibility(View.GONE);
        }
    }

    /**
     * Hero 打开：把首图先画在缩略图矩形，再动画到屏幕内的目标矩形。
     *
     * ★ 为什么要「立刻给反馈 + 超时兜底」：原生侧的解码是独立的一次请求
     * （WebView 的图片缓存不共享），首次打开可能要几百毫秒。若这段时间里
     * 什么都不显示，用户会觉得「点了没反应」。所以：
     * - 落手指令后**立刻**把幕布拉到 0.35（有明确反馈，又不是全黑）；
     * - 图在 HERO_TIMEOUT_MS 内解码好 → 播 Hero，幕布同时补到 1；
     * - 超时或失败 → 退化为「页内加载指示 + 幕布渐入」，绝不空等。
     */
    private void playOpenHero() {
        final FrameLayout root = findViewById(R.id.viewer_root);
        final int idx = startIndex;
        final String url = images.get(idx);
        final int screenW = getResources().getDisplayMetrics().widthPixels;
        final int screenH = getResources().getDisplayMetrics().heightPixels;

        // 立刻反馈：半透明幕布（pager 先隐藏，避免未定位的整图闪一下）
        scrim.setAlpha(0.35f);
        pager.setAlpha(0f);

        final boolean[] heroDone = { false };
        final Runnable timeout =
                () -> {
                    if (!heroDone[0]) {
                        heroDone[0] = true;
                        fadeInOnly();
                    }
                };
        mainHandler.postDelayed(timeout, HERO_TIMEOUT_MS);

        ImageLoader.load(url, headers, screenW, screenH, new ImageLoader.Callback() {
            @Override
            public void onSuccess(Bitmap bitmap) {
                mainHandler.removeCallbacks(timeout);
                if (heroDone[0] || isFinishing() || isDestroyed()) return;
                int bw = bitmap.getWidth();
                int bh = bitmap.getHeight();
                if (bw <= 0 || bh <= 0) {
                    heroDone[0] = true;
                    fadeInOnly();
                    return;
                }
                heroDone[0] = true;

                // 目标矩形：等比 contain 进屏幕
                float scale = Math.min((float) screenW / bw, (float) screenH / bh);
                int dstW = Math.round(bw * scale);
                int dstH = Math.round(bh * scale);
                int dstL = (screenW - dstW) / 2;
                int dstT = (screenH - dstH) / 2;

                ImageView heroView = new ImageView(ImageViewerActivity.this);
                heroView.setScaleType(ImageView.ScaleType.FIT_XY);
                heroView.setImageBitmap(bitmap);
                FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(dstW, dstH);
                lp.leftMargin = dstL;
                lp.topMargin = dstT;
                root.addView(heroView, lp);
                hero = heroView;

                // 初始映射到缩略图矩形（对目标矩形做缩放 + 平移）
                int srcW = Math.max(1, srcRect[2] - srcRect[0]);
                int srcH = Math.max(1, srcRect[3] - srcRect[1]);
                float startScale = Math.max((float) srcW / dstW, (float) srcH / dstH);
                float startCx = (srcRect[0] + srcRect[2]) / 2f;
                float startCy = (srcRect[1] + srcRect[3]) / 2f;
                float dstCx = dstL + dstW / 2f;
                float dstCy = dstT + dstH / 2f;

                heroView.setPivotX(dstW / 2f);
                heroView.setPivotY(dstH / 2f);
                heroView.setScaleX(startScale);
                heroView.setScaleY(startScale);
                heroView.setTranslationX(startCx - dstCx);
                heroView.setTranslationY(startCy - dstCy);

                ValueAnimator anim = ValueAnimator.ofFloat(0f, 1f);
                anim.setDuration(240);
                anim.setInterpolator(new DecelerateInterpolator());
                anim.addUpdateListener(a -> {
                    float t = (float) a.getAnimatedValue();
                    float s = startScale + (1f - startScale) * t;
                    heroView.setScaleX(s);
                    heroView.setScaleY(s);
                    heroView.setTranslationX((startCx - dstCx) * (1f - t));
                    heroView.setTranslationY((startCy - dstCy) * (1f - t));
                    scrim.setAlpha(0.35f + 0.65f * t);
                });
                anim.addListener(new android.animation.AnimatorListenerAdapter() {
                    @Override
                    public void onAnimationEnd(android.animation.Animator a) {
                        root.removeView(heroView);
                        hero = null;
                        pager.animate().alpha(1f).setDuration(120).start();
                    }
                });
                anim.start();
            }

            @Override
            public void onError() {
                mainHandler.removeCallbacks(timeout);
                if (heroDone[0]) return;
                heroDone[0] = true;
                fadeInOnly();
            }
        });
    }

    private void fadeInOnly() {
        pager.setAlpha(1f);
        scrim.animate().alpha(1f).setDuration(180).start();
    }

    /** 下拉关闭过程中：页面位移 + 背景变淡（跟手） */
    private void applyDismissProgress(float dx, float dy, float progress) {
        pager.setTranslationX(dx);
        pager.setTranslationY(dy);
        scrim.setAlpha(Math.max(0f, 1f - progress));
    }

    private void finishWithDismiss(boolean commit, float dx, float dy) {
        if (commit) {
            // 收盘：继续滑出并淡出，结束后返回索引
            float toY = dy >= 0 ? getResources().getDisplayMetrics().heightPixels : -dy;
            pager.animate()
                    .translationY(toY)
                    .alpha(0f)
                    .setDuration(180)
                    .withEndAction(this::finishWithResult)
                    .start();
            scrim.animate().alpha(0f).setDuration(180).start();
        } else {
            pager.animate().translationX(0f).translationY(0f).setDuration(200).start();
            scrim.animate().alpha(1f).setDuration(200).start();
        }
    }

    private void finishWithResult() {
        Intent data = new Intent();
        data.putExtra(RESULT_INDEX, currentIndex);
        setResult(Activity.RESULT_OK, data);
        finish();
        overridePendingTransition(0, 0);
    }

    /** 返回键：走返回索引的正常收尾（不要用已废弃的 onBackPressed 覆写，
     *  targetSdk 36 的 release lint 会拦；这里用 OnBackPressedDispatcher） */
    private void registerBackHandling() {
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                finishWithResult();
            }
        });
    }

    private class PageAdapter extends RecyclerView.Adapter<PageHolder> {
        @NonNull
        @Override
        public PageHolder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
            View v = LayoutInflater.from(parent.getContext())
                    .inflate(R.layout.item_image_viewer, parent, false);
            return new PageHolder(v);
        }

        @Override
        public void onBindViewHolder(@NonNull PageHolder holder, int position) {
            holder.bind(images.get(position));
        }

        @Override
        public void onViewRecycled(@NonNull PageHolder holder) {
            holder.recycle();
            super.onViewRecycled(holder);
        }

        @Override
        public int getItemCount() {
            return images.size();
        }
    }

    private class PageHolder extends RecyclerView.ViewHolder {
        private final ZoomableImageView image;
        private final ProgressBar loading;
        private final TextView error;
        private String boundUrl;

        PageHolder(@NonNull View itemView) {
            super(itemView);
            image = itemView.findViewById(R.id.viewer_image);
            loading = itemView.findViewById(R.id.viewer_loading);
            error = itemView.findViewById(R.id.viewer_error);
            image.setDragDismissListener(new ZoomableImageView.DragDismissListener() {
                @Override
                public void onDragDismiss(float dx, float dy, float progress) {
                    applyDismissProgress(dx, dy, progress);
                }

                @Override
                public void onDragDismissEnd(boolean commit, float dx, float dy) {
                    finishWithDismiss(commit, dx, dy);
                }
            });
        }

        void bind(final String url) {
            boundUrl = url;
            image.resetZoom();
            image.setImageDrawable(null);
            loading.setVisibility(View.VISIBLE);
            error.setVisibility(View.GONE);
            final int w = getResources().getDisplayMetrics().widthPixels;
            final int h = getResources().getDisplayMetrics().heightPixels;
            ImageLoader.load(url, headers, w, h, new ImageLoader.Callback() {
                @Override
                public void onSuccess(Bitmap bitmap) {
                    // 期间滑走了就别再写进去（RecyclerView 复用）
                    if (!url.equals(boundUrl)) return;
                    loading.setVisibility(View.GONE);
                    image.setImageBitmap(bitmap);
                }

                @Override
                public void onError() {
                    if (!url.equals(boundUrl)) return;
                    loading.setVisibility(View.GONE);
                    error.setVisibility(View.VISIBLE);
                    error.setText(R.string.viewer_load_failed);
                }
            });
        }

        void recycle() {
            boundUrl = null;
            image.resetZoom();
            image.setImageDrawable(null);
        }
    }
}
