package top.kuangdada.k.nativeapp.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class VoiceAudioRoutePolicyTest {
    private val speaker = VoiceAudioRoute(1, VoiceAudioRouteKind.SPEAKER)
    private val earpiece = VoiceAudioRoute(2, VoiceAudioRouteKind.EARPIECE)
    private val bluetooth = VoiceAudioRoute(3, VoiceAudioRouteKind.BLUETOOTH)
    private val wired = VoiceAudioRoute(4, VoiceAudioRouteKind.WIRED)
    private val other = VoiceAudioRoute(5, VoiceAudioRouteKind.OTHER)

    @Test
    fun bluetoothConnectedBeforeJoiningOverridesTheDefaultSpeaker() {
        val available = listOf(speaker, earpiece, bluetooth)
        assertEquals(bluetooth, selectVoiceAudioRoute(available, currentDeviceId = null))
        assertEquals(bluetooth, selectVoiceAudioRoute(available, currentDeviceId = speaker.id))
    }

    @Test
    fun connectingBluetoothWhileInTheRoomLeavesTheSpeaker() {
        val initial = selectVoiceAudioRoute(listOf(speaker, earpiece), currentDeviceId = speaker.id)
        assertEquals(speaker, initial)
        assertEquals(
            bluetooth,
            selectVoiceAudioRoute(listOf(speaker, earpiece, bluetooth), currentDeviceId = initial?.id),
        )
    }

    @Test
    fun disconnectingAndReconnectingBluetoothFallsBackThenReturnsToTheHeadset() {
        val joined = selectVoiceAudioRoute(listOf(speaker, bluetooth), currentDeviceId = speaker.id)
        val disconnected = selectVoiceAudioRoute(listOf(speaker, earpiece), currentDeviceId = joined?.id)
        val reconnected = selectVoiceAudioRoute(listOf(speaker, bluetooth), currentDeviceId = disconnected?.id)
        assertEquals(bluetooth, joined)
        assertEquals(speaker, disconnected)
        assertEquals(bluetooth, reconnected)
    }

    @Test
    fun unpluggingTheCurrentWiredHeadsetFallsBackToAvailableBluetooth() {
        assertEquals(wired, selectVoiceAudioRoute(listOf(bluetooth, speaker, wired), currentDeviceId = wired.id))
        assertEquals(bluetooth, selectVoiceAudioRoute(listOf(bluetooth, speaker), currentDeviceId = wired.id))
    }

    @Test
    fun keepCurrentBluetoothWhenAnotherHeadsetAppears() {
        val secondBluetooth = VoiceAudioRoute(6, VoiceAudioRouteKind.BLUETOOTH)
        assertEquals(
            bluetooth,
            selectVoiceAudioRoute(listOf(wired, secondBluetooth, speaker, bluetooth), currentDeviceId = bluetooth.id),
        )
    }

    @Test
    fun keepCurrentWiredHeadsetWhenTheDeviceOrderChanges() {
        val secondWired = VoiceAudioRoute(7, VoiceAudioRouteKind.WIRED)
        assertEquals(
            wired,
            selectVoiceAudioRoute(listOf(secondWired, bluetooth, speaker, wired), currentDeviceId = wired.id),
        )
    }

    @Test
    fun anUnavailableCurrentDeviceCannotOverrideTheConnectedHeadsets() {
        assertEquals(wired, selectVoiceAudioRoute(listOf(speaker, bluetooth, wired), currentDeviceId = 99))
        assertEquals(wired, selectVoiceAudioRoute(listOf(speaker, bluetooth, wired), currentDeviceId = null))
    }

    @Test
    fun withoutAnActiveHeadsetPreferWiredThenBluetoothThenSpeakerThenEarpiece() {
        assertEquals(wired, selectVoiceAudioRoute(listOf(earpiece, speaker, bluetooth, wired), currentDeviceId = speaker.id))
        assertEquals(bluetooth, selectVoiceAudioRoute(listOf(earpiece, speaker, bluetooth), currentDeviceId = earpiece.id))
        assertEquals(speaker, selectVoiceAudioRoute(listOf(earpiece, speaker), currentDeviceId = earpiece.id))
        assertEquals(earpiece, selectVoiceAudioRoute(listOf(earpiece), currentDeviceId = speaker.id))
    }

    @Test
    fun chooseFirstAvailableDeviceOfThePreferredKindWhenNoHeadsetIsCurrent() {
        val secondBluetooth = VoiceAudioRoute(6, VoiceAudioRouteKind.BLUETOOTH)
        val secondWired = VoiceAudioRoute(7, VoiceAudioRouteKind.WIRED)
        assertEquals(secondBluetooth, selectVoiceAudioRoute(listOf(speaker, secondBluetooth, bluetooth), currentDeviceId = null))
        assertEquals(secondWired, selectVoiceAudioRoute(listOf(bluetooth, secondWired, wired), currentDeviceId = null))
    }

    @Test
    fun speakerDeviceUpdatesCannotStealAudioFromAnAvailableHeadset() {
        val newSpeaker = VoiceAudioRoute(8, VoiceAudioRouteKind.SPEAKER)
        val available = listOf(newSpeaker, speaker, bluetooth)
        assertEquals(bluetooth, selectVoiceAudioRoute(available, currentDeviceId = bluetooth.id))
        assertEquals(bluetooth, selectVoiceAudioRoute(available, currentDeviceId = newSpeaker.id))
    }

    @Test
    fun unknownCurrentDeviceIsIgnoredEvenIfItIsStillPresent() {
        assertEquals(bluetooth, selectVoiceAudioRoute(listOf(other, speaker, bluetooth), currentDeviceId = other.id))
        assertEquals(earpiece, selectVoiceAudioRoute(listOf(other, earpiece), currentDeviceId = other.id))
    }

    @Test
    fun emptyOrUnsupportedDeviceListsHaveNoRoute() {
        assertNull(selectVoiceAudioRoute(emptyList(), currentDeviceId = bluetooth.id))
        assertNull(selectVoiceAudioRoute(listOf(other), currentDeviceId = other.id))
        assertNull(selectVoiceAudioRoute(listOf(other), currentDeviceId = null))
    }
}
