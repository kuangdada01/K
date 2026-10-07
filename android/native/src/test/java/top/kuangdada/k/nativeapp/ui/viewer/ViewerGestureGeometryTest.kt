package top.kuangdada.k.nativeapp.ui.viewer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ViewerGestureGeometryTest {
    @Test
    fun landscapeImageCannotBePannedIntoVerticalLetterbox() {
        assertEquals(ViewerSize(1000f, 500f), fittedImageSize(2f, 1000f, 2000f))
        assertEquals(ViewerOffset(500f, 0f), imagePanBounds(2f, 1000f, 2000f, 2f))
        assertEquals(ViewerOffset(500f, 0f), clampImageOffset(ViewerOffset(900f, 300f), imagePanBounds(2f, 1000f, 2000f, 2f)))
    }

    @Test
    fun portraitImageCannotBePannedIntoHorizontalLetterbox() {
        assertEquals(ViewerSize(500f, 2000f), fittedImageSize(0.25f, 1000f, 2000f))
        assertEquals(ViewerOffset(0f, 1000f), imagePanBounds(0.25f, 1000f, 2000f, 2f))
    }

    @Test
    fun pinchKeepsTheImagePointUnderMovingCentroid() {
        val center = ViewerOffset(500f, 1000f)
        val focal = ViewerOffset(700f, 1400f)
        val initialOffset = ViewerOffset(20f, -30f)
        val pan = ViewerOffset(15f, -10f)
        val point = ViewerOffset((focal.x - center.x - initialOffset.x) / 1.5f, (focal.y - center.y - initialOffset.y) / 1.5f)
        val transformed = zoomAroundPoint(1.5f, initialOffset, 2.5f, focal, center, pan)
        assertEquals(focal.x + pan.x, center.x + point.x * transformed.scale + transformed.offset.x, 0.001f)
        assertEquals(focal.y + pan.y, center.y + point.y * transformed.scale + transformed.offset.y, 0.001f)
    }

    @Test
    fun pinchUsesTheClampedScaleInFocalMath() {
        val transformed = zoomAroundPoint(2f, ViewerOffset(0f, 0f), 20f, ViewerOffset(750f, 1000f), ViewerOffset(500f, 1000f))
        assertEquals(4f, transformed.scale, 0f)
        assertEquals(ViewerOffset(-250f, 0f), transformed.offset)
    }

    @Test
    fun returningToFitAlwaysCentersTheImage() {
        val bounds = imagePanBounds(2f, 1000f, 2000f, 1f)
        assertEquals(ViewerOffset(0f, 0f), clampImageOffset(ViewerOffset(-400f, 200f), bounds))
    }

    @Test
    fun doubleTapFillsTheViewportAndStillZoomsScreenShapedImages() {
        assertEquals(4f, doubleTapScaleOf(2f, 1000f, 2000f), 0f)
        assertEquals(1.5f, doubleTapScaleOf(0.75f, 1000f, 2000f), 0f)
        assertEquals(2.5f, doubleTapScaleOf(0.5f, 1000f, 2000f), 0f)
        assertEquals(2.5f, doubleTapScaleOf(null, 1000f, 2000f), 0f)
        assertEquals(2.5f, doubleTapScaleOf(Float.NaN, 1000f, 2000f), 0f)
    }

    @Test
    fun coverRejectsInvalidDimensions() {
        assertEquals(null, coverScaleOf(0f, 1000f, 2000f))
        assertEquals(null, coverScaleOf(1f, 0f, 2000f))
        assertEquals(null, coverScaleOf(1f, Float.POSITIVE_INFINITY, 2000f))
        assertEquals(ViewerSize(0f, 0f), fittedImageSize(1f, 0f, 2000f))
    }

    @Test
    fun fitAndZoomBoundsHoldAcrossAspectRatios() {
        for (aspect in listOf(0.1f, 0.25f, 0.5f, 0.75f, 1f, 2f, 5f)) {
            val fitted = fittedImageSize(aspect, 1080f, 2400f)
            assertEquals(aspect, fitted.width / fitted.height, 0.0001f)
            assertTrue(fitted.width <= 1080.01f && fitted.height <= 2400.01f)
            assertEquals(ViewerOffset(0f, 0f), imagePanBounds(aspect, 1080f, 2400f, 1f))
        }
    }
}
