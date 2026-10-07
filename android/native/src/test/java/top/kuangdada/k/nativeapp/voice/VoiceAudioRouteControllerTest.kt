package top.kuangdada.k.nativeapp.voice

import org.junit.Assert.assertEquals
import org.junit.Test

class VoiceAudioRouteControllerTest {
    @Test
    fun repeatedStartDoesNotRestartAPendingBluetoothConnection() {
        val f = Fixture()
        f.controller.start()
        f.controller.start()
        assertEquals(listOf(BLUETOOTH.id), f.port.requests)
        assertEquals(1, f.clock.pendingCount)
    }

    @Test
    fun rejectedRequestRetriesOnlyAfterFiveHundredMilliseconds() {
        val f = Fixture()
        f.port.results.addAll(listOf(false, true))
        f.controller.start()
        f.controller.refresh()
        f.clock.advanceBy(499)
        assertEquals(listOf(BLUETOOTH.id), f.port.requests)
        f.clock.advanceBy(1)
        assertEquals(listOf(BLUETOOTH.id, BLUETOOTH.id), f.port.requests)
        assertEquals(0, f.port.clearCount) // A rejected request does not own a selection.
        f.port.currentId = BLUETOOTH.id
        f.controller.refresh()
        assertEquals(0, f.clock.pendingCount)
    }

    @Test
    fun acceptedRequestWaitsThirtySecondsForConfirmationBeforeRetrying() {
        val f = Fixture()
        f.controller.start()
        f.clock.advanceBy(29_999)
        assertEquals(0, f.port.clearCount)
        assertEquals(1, f.port.requests.size)
        f.clock.advanceBy(1)
        assertEquals(1, f.port.clearCount)
        assertEquals(1, f.port.requests.size)
        f.clock.advanceBy(500)
        assertEquals(listOf(BLUETOOTH.id, BLUETOOTH.id), f.port.requests)
    }

    @Test
    fun duplicateCallbacksDoNotExtendTheConnectionTimeout() {
        val f = Fixture()
        f.controller.start()
        f.clock.advanceBy(10_000)
        repeat(5) { f.controller.refresh() }
        assertEquals(1, f.port.requests.size)
        assertEquals(1, f.clock.pendingCount)
        f.clock.advanceBy(20_000)
        assertEquals(1, f.port.clearCount)
    }

    @Test
    fun clearingSelectionWithSynchronousCallbackKeepsTheRetryGuard() {
        val f = Fixture()
        f.port.onClear = f.controller::refresh
        f.controller.start()
        f.clock.advanceBy(30_000)
        assertEquals(1, f.port.requests.size)
        assertEquals(1, f.clock.pendingCount)
        f.clock.advanceBy(499)
        assertEquals(1, f.port.requests.size)
        f.clock.advanceBy(1)
        assertEquals(2, f.port.requests.size)
    }

    @Test
    fun clearingSelectionWithDelayedCallbackKeepsTheRetryGuard() {
        val f = Fixture()
        f.port.onClear = { f.clock.schedule(100, f.controller::refresh) }
        f.controller.start()
        f.clock.advanceBy(30_100)
        assertEquals(1, f.port.requests.size)
        f.clock.advanceBy(400)
        assertEquals(2, f.port.requests.size)
    }

    @Test
    fun successfulRouteHasAFreshRetryBudgetAfterTemporaryRouteLoss() {
        for (immediateConfirmation in listOf(true, false)) {
            val f = Fixture()
            f.port.confirmImmediately = immediateConfirmation
            f.controller.start()
            if (!immediateConfirmation) {
                f.port.currentId = BLUETOOTH.id
                f.controller.refresh()
            }
            assertEquals(0, f.clock.pendingCount)

            // Same headset inventory, but Android temporarily moved audio back to speaker.
            f.port.currentId = SPEAKER.id
            f.port.confirmImmediately = true
            f.port.results.addAll(listOf(false, true))
            f.port.onClear = f.controller::refresh
            f.controller.refresh()
            assertEquals(2, f.port.requests.size)
            f.clock.advanceBy(500)
            assertEquals(listOf(BLUETOOTH.id, BLUETOOTH.id, BLUETOOTH.id), f.port.requests)
            assertEquals(BLUETOOTH.id, f.port.currentId)
            assertEquals(0, f.clock.pendingCount)
        }
    }

    @Test
    fun synchronousConfirmationCallbackDoesNotCreateDuplicateRequests() {
        val f = Fixture()
        f.port.confirmImmediately = true
        f.port.onRequest = f.controller::refresh
        f.controller.start()
        assertEquals(listOf(BLUETOOTH.id), f.port.requests)
        assertEquals(0, f.clock.pendingCount)
    }

    @Test
    fun finalFailureReturnsControlToSystemWithoutRequestingSpeakerOverHeadset() {
        val f = Fixture()
        f.port.results.addAll(listOf(true, false))
        f.port.onClear = f.controller::refresh
        f.controller.start()
        f.clock.advanceBy(30_500)
        repeat(5) { f.controller.refresh() }
        f.clock.advanceBy(60_000)
        assertEquals(listOf(BLUETOOTH.id, BLUETOOTH.id), f.port.requests)
        assertEquals(1, f.port.clearCount)
        assertEquals(0, f.clock.pendingCount)
    }

    @Test
    fun disconnectChangesTargetAndInvalidatesTheOldConnectionTimeout() {
        val f = Fixture()
        f.controller.start()
        val oldTimeout = f.clock.tasks.last()
        f.port.devices = listOf(SPEAKER)
        f.controller.refresh()
        assertEquals(listOf(BLUETOOTH.id, SPEAKER.id), f.port.requests)
        assertEquals(0, f.clock.pendingCount)
        oldTimeout.action() // Simulate a callback already queued when cancellation happened.
        assertEquals(0, f.port.clearCount)
        assertEquals(2, f.port.requests.size)
    }

    @Test
    fun reconnectingAfterARejectedDeviceWasBlockedAllowsANewRequest() {
        val f = Fixture()
        f.port.results.addAll(listOf(false, false))
        f.controller.start()
        f.clock.advanceBy(500)
        f.controller.refresh()
        assertEquals(2, f.port.requests.size)
        f.port.devices = listOf(SPEAKER)
        f.controller.refresh()
        f.port.devices = listOf(SPEAKER, BLUETOOTH)
        f.controller.refresh()
        assertEquals(listOf(BLUETOOTH.id, BLUETOOTH.id, SPEAKER.id, BLUETOOTH.id), f.port.requests)
    }

    @Test
    fun stopCancelsTimersAndIgnoresLateDeviceCallbacks() {
        val f = Fixture()
        f.port.onClear = f.controller::refresh
        f.controller.start()
        val oldTimeout = f.clock.tasks.last()
        f.controller.stop()
        f.controller.stop()
        assertEquals(1, f.port.clearCount)
        assertEquals(0, f.clock.pendingCount)
        oldTimeout.action()
        f.controller.refresh()
        f.clock.advanceBy(60_000)
        assertEquals(listOf(BLUETOOTH.id), f.port.requests)
        assertEquals(1, f.port.clearCount)
    }

    @Test
    fun lateTimeoutFromPreviousSessionCannotCancelTheNewSession() {
        val f = Fixture()
        f.controller.start()
        val oldTimeout = f.clock.tasks.last()
        f.controller.stop()
        f.controller.start()
        oldTimeout.action()
        assertEquals(listOf(BLUETOOTH.id, BLUETOOTH.id), f.port.requests)
        assertEquals(1, f.port.clearCount)
        assertEquals(1, f.clock.pendingCount)
    }

    private class Fixture {
        val port = FakePort()
        val clock = FakeClock()
        val controller = VoiceAudioRouteController(port, clock)
    }

    private class FakePort : VoiceAudioRoutePort {
        var devices = listOf(SPEAKER, BLUETOOTH)
        var currentId: Int? = SPEAKER.id
        var confirmImmediately = false
        val results = mutableListOf<Boolean>()
        val requests = mutableListOf<Int>()
        var clearCount = 0
        var onClear: (() -> Unit)? = null
        var onRequest: (() -> Unit)? = null

        override fun snapshot() = VoiceAudioRouteSnapshot(devices, currentId)

        override fun request(deviceId: Int): Boolean {
            requests += deviceId
            val accepted = if (results.isEmpty()) true else results.removeAt(0)
            if (accepted && confirmImmediately) currentId = deviceId
            onRequest?.invoke()
            return accepted
        }

        override fun clear() {
            clearCount++
            currentId = SPEAKER.id
            onClear?.invoke()
        }
    }

    private class FakeClock : VoiceAudioRouteScheduler {
        data class Task(val due: Long, val action: () -> Unit, var cancelled: Boolean = false, var fired: Boolean = false)
        val tasks = mutableListOf<Task>()
        private var now = 0L
        val pendingCount: Int get() = tasks.count { !it.cancelled && !it.fired }

        override fun schedule(delayMs: Long, action: () -> Unit): VoiceAudioRouteCancellation {
            val task = Task(now + delayMs, action)
            tasks += task
            return VoiceAudioRouteCancellation { task.cancelled = true }
        }

        fun advanceBy(durationMs: Long) {
            val target = now + durationMs
            while (true) {
                val task = tasks.filter { !it.cancelled && !it.fired && it.due <= target }
                    .minByOrNull { it.due } ?: break
                now = task.due
                task.fired = true
                task.action()
            }
            now = target
        }
    }

    private companion object {
        val SPEAKER = VoiceAudioRoute(1, VoiceAudioRouteKind.SPEAKER)
        val BLUETOOTH = VoiceAudioRoute(2, VoiceAudioRouteKind.BLUETOOTH)
    }
}
