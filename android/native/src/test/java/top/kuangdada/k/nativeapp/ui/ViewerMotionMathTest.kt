package top.kuangdada.k.nativeapp.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ViewerMotionMathTest {
    @Test
    fun transitionOpacityReachesBothEndpointsAndClampsProgress() {
        assertEquals(0f, viewerTransitionAlpha(0f, 1f, 0f), 0f)
        assertEquals(1f, viewerTransitionAlpha(0f, 1f, 1f), 0f)
        assertEquals(0f, viewerTransitionAlpha(0f, 1f, -0.2f), 0f)
        assertEquals(1f, viewerTransitionAlpha(0f, 1f, 1.2f), 0f)
        assertEquals(0.6f, viewerTransitionAlpha(0.6f, 0f, 0f), 0f)
        assertEquals(0f, viewerTransitionAlpha(0.6f, 0f, 1f), 0f)
    }

    @Test
    fun closingAfterDragStartsAtTheAlreadyVisibleBackdropOpacity() {
        for (drag in listOf(0f, 0.1f, 1f / 6f, 0.25f, 1f)) {
            val visible = viewerMaskAlpha(transitioning = false, maskT = 1f, dragFraction = drag)
            assertEquals(visible, viewerTransitionAlpha(visible, 0f, 0f), 0f)
            assertEquals(visible, viewerMaskAlpha(transitioning = true, maskT = 1f, dragFraction = drag), 0f)
            assertEquals(0f, viewerTransitionAlpha(visible, 0f, 1f), 0f)
        }
    }

    @Test
    fun closingBackdropFadesWithoutBrighteningOrLeavingItsRange() {
        val initial = dragAlphaOf(0.15f)
        var previous = initial
        for (step in 0..100) {
            val alpha = viewerTransitionAlpha(initial, 0f, step / 100f)
            assertTrue(alpha in 0f..initial)
            assertTrue(alpha <= previous)
            previous = alpha
        }
        assertEquals(0f, previous, 0f)
    }

    @Test
    fun highVelocityFlingCannotSkipMultipleImages() {
        assertEquals(4, viewerPageTarget(3.2f, 100_000f, 1000f, startPage = 3, count = 9))
        assertEquals(2, viewerPageTarget(2.8f, -100_000f, 1000f, startPage = 3, count = 9))
        // Clamp against the gesture's starting page even after a large raw scroll.
        assertEquals(4, viewerPageTarget(6f, 3000f, 1000f, startPage = 3, count = 9))
        assertEquals(2, viewerPageTarget(0f, -3000f, 1000f, startPage = 3, count = 9))
    }

    @Test
    fun pageTargetStaysInsideTheGalleryAtBothEnds() {
        assertEquals(0, viewerPageTarget(0f, -100_000f, 1000f, startPage = 0, count = 5))
        assertEquals(4, viewerPageTarget(4f, 100_000f, 1000f, startPage = 4, count = 5))
        assertEquals(0, viewerPageTarget(0.6f, 100_000f, 1000f, startPage = 0, count = 1))
        assertEquals(0, viewerPageTarget(0f, 100_000f, 1000f, startPage = 0, count = 0))
    }

    @Test
    fun reverseFlingGoesOnePageInTheFlingDirection() {
        // 速度来自分页器 delta 流，符号可信：明确的回甩按甩的方向翻页（ViewPager2 手感）
        assertEquals(1, viewerPageTarget(2.7f, -2000f, 500f, startPage = 2, count = 6))
        assertEquals(1, viewerPageTarget(2.2f, -3000f, 500f, startPage = 2, count = 6))
        assertEquals(3, viewerPageTarget(1.8f, 3000f, 500f, startPage = 2, count = 6))
    }

    @Test
    fun slowSwipeBelowFlickThresholdSettlesByDragDistance() {
        // 真机日志（16:46~16:48）的那批手势，换成 delta 流速度后：慢速前拖 0.39~0.46 页、
        // 抬手回卷只给几百 px/s 的速度 → 只看拖动距离，全部翻页
        assertEquals(3, viewerPageTarget(2.389f, 600f, 1440f, startPage = 2, count = 9))
        assertEquals(3, viewerPageTarget(2.458f, 400f, 1440f, startPage = 2, count = 9))
        // 不到 0.35 页仍然弹回
        assertEquals(2, viewerPageTarget(2.316f, 500f, 1440f, startPage = 2, count = 9))
        // 往回拖 0.36 页翻回上一张
        assertEquals(1, viewerPageTarget(1.64f, 0f, 1000f, startPage = 2, count = 6))
    }

    @Test
    fun slowDragSettlesOnTheClosestImage() {
        // 翻页线已从 0.5 提前到 0.35（用户反馈"拖 40% 弹回来像撞墙"）
        assertEquals(2, viewerPageTarget(2.34f, 0f, 1000f, startPage = 2, count = 6))
        assertEquals(3, viewerPageTarget(2.36f, 0f, 1000f, startPage = 2, count = 6))
        assertEquals(1, viewerPageTarget(1.64f, 0f, 1000f, startPage = 2, count = 6))
        assertEquals(2, viewerPageTarget(1.66f, 0f, 1000f, startPage = 2, count = 6))
    }

    @Test
    fun hardReverseFlingTurnsOnePageInTheFlingDirection() {
        // 速度符号已由 delta 流保证可信：明确的逆向硬甩直接朝甩的方向翻页，
        // 页宽不再参与（真机日志里"右滑却前进到下一张"就是旧投影规则造成的）
        assertEquals(1, viewerPageTarget(2.7f, -3000f, 500f, startPage = 2, count = 6))
        assertEquals(1, viewerPageTarget(2.7f, -3000f, 1000f, startPage = 2, count = 6))
        // 页宽未测量（0）也一样，疯狂甩也最多翻一页
        assertEquals(1, viewerPageTarget(2.7f, -100_000f, 0f, startPage = 2, count = 6))
    }

    @Test
    fun deliberateFlickTurnsOnePageRegardlessOfDragDistanceOrPageWidth() {
        // A short flick from rest must reach the next image — the old projection-only rule
        // demanded "half a page dragged or a hard flick", which felt damped (user report).
        assertEquals(3, viewerPageTarget(2.05f, 1500f, 1000f, startPage = 2, count = 6))
        assertEquals(3, viewerPageTarget(2.05f, 1500f, 2000f, startPage = 2, count = 6))
        assertEquals(1, viewerPageTarget(1.95f, -1500f, 1000f, startPage = 2, count = 6))
        // A flick landing exactly where it started still counts as a flick.
        assertEquals(3, viewerPageTarget(2f, 3000f, 2000f, startPage = 2, count = 6))
    }

    @Test
    fun hardPullBackAfterForwardDragGoesBack() {
        // 真机日志 16:46:28.891：拖到 +0.38 后狠狠往回拽（delta 流速度 -8943）→ 回到上一张
        assertEquals(1, viewerPageTarget(2.369f, -4704f, 1440f, startPage = 2, count = 9))
        assertEquals(1, viewerPageTarget(2.379f, -8943f, 1440f, startPage = 2, count = 9))
    }

    @Test
    fun gentleReleaseSettlesByDragDistance() {
        // 速度低于轻拂门槛时完全不看速度：0.36 页翻、0.34 页不翻（0.35 是浮点边界，避开）
        assertEquals(3, viewerPageTarget(2.36f, 800f, 1000f, startPage = 2, count = 6))
        assertEquals(2, viewerPageTarget(2.34f, 800f, 1000f, startPage = 2, count = 6))
        assertEquals(2, viewerPageTarget(2.30f, 300f, 1000f, startPage = 2, count = 6))
        // 反向对称：往回拖 35% 翻回上一张
        assertEquals(1, viewerPageTarget(1.64f, 0f, 1000f, startPage = 2, count = 6))
    }

    @Test
    fun dragFeedbackStartsFullSizeAndStopsAtItsVisualLimits() {
        assertEquals(1f, dismissScaleOf(0f), 0f)
        assertEquals(1f, dragAlphaOf(0f), 0f)
        assertEquals(0.9f, dismissScaleOf(0.1f), 0.0001f)
        assertEquals(0.8f, dragAlphaOf(0.1f), 0.0001f)
        assertEquals(0.75f, dismissScaleOf(0.25f), 0f)
        assertEquals(0.5f, dragAlphaOf(0.25f), 0f)
        for (fraction in listOf(0.25f, 0.5f, 1f, 100f)) {
            assertEquals(MIN_DRAG_SCALE, dismissScaleOf(fraction), 0f)
            assertEquals(MIN_DRAG_ALPHA, dragAlphaOf(fraction), 0f)
        }
        assertEquals(1f, dismissScaleOf(-1f), 0f)
        assertEquals(1f, dragAlphaOf(-1f), 0f)
    }
}
