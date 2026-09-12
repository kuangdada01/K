package com.k.app;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Matrix;
import android.graphics.RectF;
import android.graphics.drawable.Drawable;
import android.util.AttributeSet;
import android.view.GestureDetector;
import android.view.MotionEvent;
import android.view.ScaleGestureDetector;
import android.view.ViewParent;
import android.view.animation.DecelerateInterpolator;

import androidx.annotation.Nullable;
import androidx.appcompat.widget.AppCompatImageView;

/**
 * ============================================================
 * 可缩放图片视图（ZoomableImageView）—— 原生图片查看器的手势核心
 * ============================================================
 * 与网页层 useImagePinchZoom 同一套语义，但跑在原生 UI 线程上：
 * - 双指捏合缩放 1x–4x（围绕捏合中点，跟手）
 * - 放大后单指拖动平移，边缘钳制（不露黑边）
 * - 双击：以双击点为锚放大到 2.5x；已放大则缩回 1x（带 250ms 缓动）
 * - 缩放为 1x 时把横向手势让给 ViewPager2 翻页；放大态则截断父级拦截，
 *   单指拖动只平移图片
 * - 1x 时纵向下拉触发「拖拽关闭」（微信/系统相册的标志性手势），
 *   位移与进度回报给宿主做背景淡出
 * ============================================================
 */
public class ZoomableImageView extends AppCompatImageView {

    /** 双指缩放上下限（与网页层一致） */
    public static final float MIN_SCALE = 1f;
    public static final float MAX_SCALE = 4f;
    /** 双击放大目标倍率 */
    public static final float DOUBLE_TAP_SCALE = 2.5f;
    /** 双击/回弹动画时长（ms） */
    private static final long ANIM_MS = 250;
    /** 判定为「纵向拖拽关闭」的起始位移（px） */
    private static final float DISMISS_SLOP = 12f;
    /** 拖拽进度达到该值即视为请求关闭 */
    private static final float DISMISS_COMMIT = 0.28f;

    /** 拖拽关闭回调：位移与进度交给宿主（背景淡出/页面位移） */
    public interface DragDismissListener {
        void onDragDismiss(float dx, float dy, float progress);

        void onDragDismissEnd(boolean commit, float dx, float dy);
    }

    private final Matrix suppMatrix = new Matrix();
    private final Matrix baseMatrix = new Matrix();
    private final float[] matrixValues = new float[9];
    private final RectF displayRect = new RectF();

    private ScaleGestureDetector scaleDetector;
    private GestureDetector gestureDetector;
    @Nullable
    private DragDismissListener dismissListener;

    /** 双击/回弹动画（同一时刻只允许一个） */
    @Nullable
    private ValueAnimator animator;

    /** 是否正在拖拽关闭（一旦进入，本次手势全部由本视图消费） */
    private boolean dismissing = false;
    private float dismissStartX = 0f;
    private float dismissStartY = 0f;
    private float dismissDx = 0f;
    private float dismissDy = 0f;

    public ZoomableImageView(Context context) {
        this(context, null);
    }

    public ZoomableImageView(Context context, @Nullable AttributeSet attrs) {
        this(context, attrs, 0);
    }

    public ZoomableImageView(Context context, @Nullable AttributeSet attrs, int defStyleAttr) {
        super(context, attrs, defStyleAttr);
        setScaleType(ScaleType.MATRIX);
        setAdjustViewBounds(false);
        scaleDetector = new ScaleGestureDetector(context, new ScaleListener());
        // 双指捏合时不希望父级（ViewPager2）跟着翻页
        scaleDetector.setQuickScaleEnabled(false);
        gestureDetector = new GestureDetector(context, new GestureListener());
        gestureDetector.setOnDoubleTapListener(new GestureListener());
    }

    public void setDragDismissListener(@Nullable DragDismissListener l) {
        this.dismissListener = l;
    }

    /** 当前缩放倍率 */
    public float getScale() {
        suppMatrix.getValues(matrixValues);
        return matrixValues[Matrix.MSCALE_X];
    }

    /** 是否处于放大态（> 1.01 视为放大，避免浮点误差） */
    public boolean isZoomed() {
        return getScale() > 1.01f;
    }

    /** 复位到 1x（翻页/关闭时调用） */
    public void resetZoom() {
        cancelAnimator();
        suppMatrix.reset();
        applyMatrix();
    }

    // ---------------- 触摸分发 ----------------

    @Override
    public boolean onTouchEvent(MotionEvent event) {
        if (getDrawable() == null) return super.onTouchEvent(event);
        scaleDetector.onTouchEvent(event);
        gestureDetector.onTouchEvent(event);

        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                cancelAnimator();
                dismissing = false;
                dismissStartX = event.getX();
                dismissStartY = event.getY();
                dismissDx = 0f;
                dismissDy = 0f;
                // 放大态落指即截断父级：本轮手势整段由本视图平移，
                // 绝不让 ViewPager2 翻页（下一轮手势系统会自动复位该标志）
                if (isZoomed()) requestDisallowIntercept(true);
                break;
            case MotionEvent.ACTION_MOVE:
                if (!scaleDetector.isInProgress() && event.getPointerCount() == 1 && !isZoomed()) {
                    float dy = event.getY() - dismissStartY;
                    float dx = event.getX() - dismissStartX;
                    // 1x 下「向下为主」的下拉进入拖拽关闭（微信/系统相册都是下拉关闭，
                    // 上滑不关）；横向为主则不动，让 ViewPager2 正常翻页（不截断父级）
                    if (!dismissing
                            && dy > DISMISS_SLOP
                            && dy > Math.abs(dx)) {
                        dismissing = true;
                        requestDisallowIntercept(true);
                    }
                    if (dismissing) {
                        dismissDy = dy;
                        dismissDx = dx;
                        float progress = Math.min(1f, dy / (getHeight() * 0.6f));
                        if (dismissListener != null) dismissListener.onDragDismiss(dismissDx, dismissDy, progress);
                        return true;
                    }
                }
                break;
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL:
                if (dismissing) {
                    dismissing = false;
                    requestDisallowIntercept(false);
                    // 只认下拉（dy > 0）；上滑即使过阈值也不算关闭
                    boolean commit = dismissDy > getHeight() * DISMISS_COMMIT;
                    if (dismissListener != null) dismissListener.onDragDismissEnd(commit, dismissDx, dismissDy);
                    return true;
                }
                break;
            default:
                break;
        }
        return true;
    }

    private void requestDisallowIntercept(boolean disallow) {
        ViewParent parent = getParent();
        if (parent != null) parent.requestDisallowInterceptTouchEvent(disallow);
    }

    /** 双指缩放：围绕捏合中点，跟手 */
    private class ScaleListener extends ScaleGestureDetector.SimpleOnScaleGestureListener {
        @Override
        public boolean onScale(ScaleGestureDetector detector) {
            float current = getScale();
            float target = current * detector.getScaleFactor();
            target = Math.max(MIN_SCALE, Math.min(MAX_SCALE, target));
            float factor = target / current;

            // 以捏合焦点为锚点缩放：先平移到焦点、缩放、再平移回去
            float focusX = detector.getFocusX();
            float focusY = detector.getFocusY();
            suppMatrix.postScale(factor, factor, focusX, focusY);
            applyMatrix();
            // 放大态截断父级翻页；缩回 1x 时交还
            requestDisallowIntercept(isZoomed() || detector.isInProgress());
            return true;
        }

        @Override
        public boolean onScaleBegin(ScaleGestureDetector detector) {
            cancelAnimator();
            requestDisallowIntercept(true);
            return true;
        }

        @Override
        public void onScaleEnd(ScaleGestureDetector detector) {
            settleIfNeeded();
        }
    }

    /** 双击 + 单指拖动 */
    private class GestureListener extends GestureDetector.SimpleOnGestureListener {
        @Override
        public boolean onDown(MotionEvent e) {
            return true;
        }

        @Override
        public boolean onDoubleTap(MotionEvent e) {
            if (isZoomed()) {
                animateTo(1f, e.getX(), e.getY());
            } else {
                animateTo(DOUBLE_TAP_SCALE, e.getX(), e.getY());
            }
            return true;
        }

        @Override
        public boolean onScroll(MotionEvent e1, MotionEvent e2, float distanceX, float distanceY) {
            // 只有放大态才由本视图平移；1x 交给 ViewPager2 / 拖拽关闭
            if (!isZoomed() || scaleDetector.isInProgress()) return false;
            // ★ 每次 ACTION_DOWN 系统都会重置 disallowIntercept 标志，所以放大态
            //   必须在手势内重新截断父级，否则横向拖动会被 ViewPager2 抢去翻页
            //   （症状：放大后拖动变成翻页，而不是平移图片）
            requestDisallowIntercept(true);
            suppMatrix.postTranslate(-distanceX, -distanceY);
            applyMatrix();
            return true;
        }

        @Override
        public boolean onFling(MotionEvent e1, MotionEvent e2, float velocityX, float velocityY) {
            return isZoomed();
        }
    }

    // ---------------- 矩阵与边界 ----------------

    @Override
    protected void onSizeChanged(int w, int h, int oldw, int oldh) {
        super.onSizeChanged(w, h, oldw, oldh);
        updateBaseMatrix();
    }

    @Override
    public void setImageDrawable(@Nullable Drawable drawable) {
        super.setImageDrawable(drawable);
        updateBaseMatrix();
    }

    /** 等比居中铺满可视区（contain） */
    private void updateBaseMatrix() {
        Drawable d = getDrawable();
        if (d == null || getWidth() == 0 || getHeight() == 0) return;
        float vw = getWidth();
        float vh = getHeight();
        float dw = d.getIntrinsicWidth();
        float dh = d.getIntrinsicHeight();
        if (dw <= 0 || dh <= 0) dw = vw;
        if (dw <= 0 || dh <= 0) dh = vh;
        float scale = Math.min(vw / dw, vh / dh);
        float dx = (vw - dw * scale) / 2f;
        float dy = (vh - dh * scale) / 2f;
        baseMatrix.reset();
        baseMatrix.postScale(scale, scale);
        baseMatrix.postTranslate(dx, dy);
        applyMatrix();
    }

    /** 合成 base * supp 并按边界钳制后写回 */
    private void applyMatrix() {
        Matrix m = new Matrix(baseMatrix);
        m.postConcat(suppMatrix);
        setImageMatrix(m);
        checkBounds();
    }

    /** 边缘钳制：放大后的图片必须始终盖住视图；小于视图的轴则居中 */
    private void checkBounds() {
        Matrix m = new Matrix(baseMatrix);
        m.postConcat(suppMatrix);
        Drawable d = getDrawable();
        if (d == null) return;
        displayRect.set(0, 0, d.getIntrinsicWidth(), d.getIntrinsicHeight());
        m.mapRect(displayRect);

        float deltaX = 0f;
        float deltaY = 0f;
        float vw = getWidth();
        float vh = getHeight();
        float rectW = displayRect.width();
        float rectH = displayRect.height();

        if (rectW <= vw) {
            deltaX = (vw - rectW) / 2f - displayRect.left;
        } else if (displayRect.left > 0) {
            deltaX = -displayRect.left;
        } else if (displayRect.right < vw) {
            deltaX = vw - displayRect.right;
        }
        if (rectH <= vh) {
            deltaY = (vh - rectH) / 2f - displayRect.top;
        } else if (displayRect.top > 0) {
            deltaY = -displayRect.top;
        } else if (displayRect.bottom < vh) {
            deltaY = vh - displayRect.bottom;
        }
        if (deltaX != 0f || deltaY != 0f) {
            suppMatrix.postTranslate(deltaX, deltaY);
            Matrix m2 = new Matrix(baseMatrix);
            m2.postConcat(suppMatrix);
            setImageMatrix(m2);
        }
    }

    /** 松手后若缩回 1x 附近则吸附回 1x（避免停在 1.02 这种「半吊子」放大态） */
    private void settleIfNeeded() {
        if (getScale() < 1.05f) {
            animateTo(1f, getWidth() / 2f, getHeight() / 2f);
        }
    }

    /** 以 (focusX, focusY) 为锚点动画到目标缩放 */
    private void animateTo(float targetScale, float focusX, float focusY) {
        cancelAnimator();
        final float startScale = getScale();
        final float scaleDelta = targetScale / startScale;
        // 目标位移：把锚点保持在原位
        suppMatrix.getValues(matrixValues);
        final float startTx = matrixValues[Matrix.MTRANS_X];
        final float startTy = matrixValues[Matrix.MTRANS_Y];
        final float endTx = focusX - (focusX - startTx) * scaleDelta;
        final float endTy = focusY - (focusY - startTy) * scaleDelta;

        animator = ValueAnimator.ofFloat(0f, 1f);
        animator.setDuration(ANIM_MS);
        animator.setInterpolator(new DecelerateInterpolator());
        animator.addUpdateListener(a -> {
            float t = (float) a.getAnimatedValue();
            float s = startScale * (float) Math.pow(scaleDelta, t);
            suppMatrix.getValues(matrixValues);
            // 直接重建：scale 按插值，位移按线性插值
            suppMatrix.reset();
            suppMatrix.postScale(s, s);
            suppMatrix.postTranslate(startTx + (endTx - startTx) * t, startTy + (endTy - startTy) * t);
            applyMatrix();
        });
        animator.start();
    }

    private void cancelAnimator() {
        if (animator != null) {
            animator.cancel();
            animator = null;
        }
    }

    @Override
    protected void onDetachedFromWindow() {
        cancelAnimator();
        super.onDetachedFromWindow();
    }
}
