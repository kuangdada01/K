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
    /** Hero 等待解码的上限（ms）：超过就退化为淡入，避免「点了没反应」。
     *  ★ 曾经是 180ms —— 但原生侧的解码是**独立的一次网络请求**（WebView 的图片
     *  缓存不共享，且拿的是原图），真机上往往要几百毫秒到 1s 以上；180ms 一到就
     *  切到「黑底 + 转圈」，等图到了再蹦出来 —— 这正是真机反馈的
     *  「从缩略图放大进入有闪烁」。现在给足 1.5s：期间保持原样（只有一层很淡的
     *  幕布做「已响应」反馈），图一到就从缩略图位置长出来，全程没有切换跳变 */
    private static final long HERO_TIMEOUT_MS = 1500;
    /** Hero 落位后等页面自己把图画好的上限（ms）：超过就强制交接，避免一直顶着 */
    private static final long HERO_SWAP_TIMEOUT_MS = 1200;
    /** Hero 是否还在顶屏（等页面就绪后才交接） */
    private boolean heroActive = false;

    private final android.os.Handler mainHandler = new android.os.Handler(android.os.Looper.getMainLooper());

    private ViewPager2 pager;
    private TextView counter;
    private View scrim;
    @Nullable
    private ImageView hero;
    /** Hero 入场动画（用户中途下拉时要能取消，否则图会卡在中间缩放态） */
    @Nullable
    private ValueAnimator heroAnimator;
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
        // ★ 必须走 finishWithResult：直接 finish() 不带结果，插件拿到的 index 就是 -1，
        //   网页层无法把主轮播对齐到「刚才看的那张」——
        //   真机反馈「返回后详情页主轮播跟退出时不是同一张」的一种成因
        close.setOnClickListener(v -> finishWithResult());

        pager.setAdapter(new PageAdapter());
        pager.setOffscreenPageLimit(1);
        pager.setCurrentItem(startIndex, false);
        pager.registerOnPageChangeCallback(new ViewPager2.OnPageChangeCallback() {
            @Override
            public void onPageSelected(int position) {
                setCurrentIndex(position);
            }

            @Override
            public void onPageScrolled(int position, float positionOffset, int offsetPixels) {
                // 拖动/惯性过程中也跟踪「离哪张更近」：松手瞬间（甚至还在滑）按返回键
                // 时返回的索引，必须与眼睛看到的那张一致；顺带让计数实时跟着走
                if (positionOffset > 0.5f) {
                    setCurrentIndex(position + 1);
                } else {
                    setCurrentIndex(position);
                }
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

    /**
     * 全屏沉浸：状态栏隐藏，窗口透明（Hero 需要能看到下层）。
     *
     * ★ 只隐藏**状态栏**，导航栏保持「透明但存在」：
     * 导航栏一旦被隐藏，手势导航下的返回手势会被系统先用来「唤出系统栏」，
     * 应用收不到那一次返回 —— 真机反馈的「要返回两次」正是这个。
     * 导航栏透明且压在黑色幕布上（图标是深色），观感上仍是全屏。
     */
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
            c.hide(WindowInsetsCompat.Type.statusBars());
            c.setSystemBarsBehavior(
                    WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        }
    }

    /** 当前页变化（含拖动中的「更近哪张」）→ 更新计数 */
    private void setCurrentIndex(int index) {
        int clamped = Math.max(0, Math.min(index, Math.max(0, images.size() - 1)));
        if (clamped == currentIndex) return;
        currentIndex = clamped;
        updateCounter();
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
     * （WebView 的图片缓存不共享，且这里要的是原图），首次打开常常要几百毫秒
     * 甚至更久。若这段时间里什么都不显示，用户会觉得「点了没反应」。所以：
     * - 落手指令后**立刻**把幕布拉到 0.35（有明确反馈，又不是全黑）；
     * - 图在 HERO_TIMEOUT_MS 内解码好 → 播 Hero，幕布同时补到 1；
     * - 超时或失败 → 退化为「页内加载指示 + 幕布渐入」，绝不空等。
     *
     * ★ 超时值必须足够大（1.5s）：曾经是 180ms，真机上几乎必然先超时切黑再出图，
     * 观感就是「从缩略图放大进来闪一下」。
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
                // 从 0 淡入（见下方 updateListener）：即使图是秒到的缓存命中，
                // 也不会在「被压暗的下层缩略图」上突然弹出一块更亮的图（观感上的闪）
                heroView.setAlpha(0f);
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
                heroAnimator = anim;
                anim.addUpdateListener(a -> {
                    float t = (float) a.getAnimatedValue();
                    float s = startScale + (1f - startScale) * t;
                    heroView.setScaleX(s);
                    heroView.setScaleY(s);
                    heroView.setTranslationX((startCx - dstCx) * (1f - t));
                    heroView.setTranslationY((startCy - dstCy) * (1f - t));
                    // 前 20% 淡入：避免「图突然出现」的一帧跳变
                    heroView.setAlpha(Math.min(1f, t * 5f));
                    scrim.setAlpha(0.35f + 0.65f * t);
                });
                anim.addListener(new android.animation.AnimatorListenerAdapter() {
                    @Override
                    public void onAnimationEnd(android.animation.Animator a) {
                        heroAnimator = null;
                        // Hero 可能已被下拉关闭接管（见 dropHeroForDrag）：那就什么都不做
                        if (hero == null) return;
                        // ★ 关键交接：Hero 已落到目标位置，但页面自己的图**可能还没解码完**
                        //   （同一张图但各自独立加载）。此时若直接撤掉 Hero 并淡入页面，
                        //   就会闪一下黑/转圈 —— 真机反馈的「从缩略图放大进入有闪烁」。
                        //   做法：Hero 继续顶着（同图同位置，视觉上完全一致），
                        //   等页面把图画好了再一次性交接（无淡入）。
                        heroActive = true;
                        if (isStartPageRendered()) {
                            swapHeroOut();
                        } else {
                            mainHandler.postDelayed(ImageViewerActivity.this::swapHeroOut, HERO_SWAP_TIMEOUT_MS);
                        }
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

    /** 首图所在页是否已经把位图设上去了 */
    private boolean isStartPageRendered() {
        PageHolder h = holderAt(startIndex);
        return h != null && h.isRendered();
    }

    /** 页面就绪通知（PageHolder 画好图后回调） */
    private void notifyPageReady(int position) {
        if (heroActive && position == startIndex) swapHeroOut();
    }

    /** Hero 交接：撤掉 Hero 并让页面瞬间显示（不做淡入，避免闪一帧） */
    private void swapHeroOut() {
        if (!heroActive) return;
        heroActive = false;
        if (hero != null) {
            ViewGroup parent = (ViewGroup) hero.getParent();
            if (parent != null) parent.removeView(hero);
            hero = null;
        }
        pager.setAlpha(1f);
        scrim.setAlpha(1f);
    }

    /** 取指定位置的 ViewHolder（ViewPager2 内部是 RecyclerView） */
    @Nullable
    private PageHolder holderAt(int position) {
        if (!(pager.getChildAt(0) instanceof RecyclerView)) return null;
        RecyclerView rv = (RecyclerView) pager.getChildAt(0);
        RecyclerView.ViewHolder vh = rv.findViewHolderForAdapterPosition(position);
        return vh instanceof PageHolder ? (PageHolder) vh : null;
    }

    /**
     * Hero 还在屏幕上时开始下拉关闭：先把 Hero 交接掉。
     *
     * Hero 是 root 里的独立图层（不在 pager 内），下拉位移只作用于 pager ——
     * 若不交接，图像会「卡住不动」，看着像坏了。交接是安全的：同一个 URL 刚刚
     * 已经被 Hero 解码过，页面那次加载必然命中 ImageLoader 的内存缓存。
     * 同时取消入场动画（否则它结束后会把 heroActive 翻回 true 并排一个
     * 1200ms 的交接定时器，把正在淡出的画面又拉回不透明）。
     */
    private void dropHeroForDrag() {
        if (hero == null) return;
        heroActive = true; // 入场动画可能还没结束，先允许 swapHeroOut 生效
        swapHeroOut();
        if (heroAnimator != null) {
            ValueAnimator a = heroAnimator;
            heroAnimator = null;
            a.cancel(); // onAnimationEnd 里 hero == null → 直接返回，不会重排交接
        }
    }

    /** 下拉关闭过程中：页面位移 + 背景变淡（跟手） */
    private void applyDismissProgress(float dx, float dy, float progress) {
        dropHeroForDrag();
        pager.setTranslationX(dx);
        pager.setTranslationY(dy);
        scrim.setAlpha(Math.max(0f, 1f - progress));
    }

    private void finishWithDismiss(boolean commit, float dx, float dy) {
        dropHeroForDrag();
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
            holder.position = position;
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
        /** 该 holder 当前对应的数据位置（Hero 交接判断用） */
        int position = -1;

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
            // 点一下退出全屏（双击窗口内没有第二下时）——原生相册/微信的行为。
            // 之前只能按返回键或点右上角，用户反馈「不能点击退出全屏」。
            image.setSingleTapListener(ImageViewerActivity.this::finishWithResult);
        }

        /** 首图是否已经画上去（供 Hero 交接判断，见 bind 中的 notifyPageReady） */
        private boolean rendered;

        boolean isRendered() {
            return rendered;
        }

        void bind(final String url) {
            boundUrl = url;
            rendered = false;
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
                    rendered = true;
                    // 页面自己画好了：如果 Hero 还在顶屏，现在交接（无闪烁）
                    notifyPageReady(position);
                }

                @Override
                public void onError() {
                    if (!url.equals(boundUrl)) return;
                    loading.setVisibility(View.GONE);
                    error.setVisibility(View.VISIBLE);
                    error.setText(R.string.viewer_load_failed);
                    // 加载失败也要交接，否则 Hero 一直顶着、用户以为卡住
                    notifyPageReady(position);
                }
            });
        }

        void recycle() {
            boundUrl = null;
            rendered = false;
            image.resetZoom();
            image.setImageDrawable(null);
        }
    }
}
