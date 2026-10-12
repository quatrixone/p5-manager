package com.p5manager.app.rp

/**
 * A Remote Play session held by libchiaki in this process. The console's
 * video and audio arrive here as the console encoded them; what plays them
 * is [listener]'s business.
 *
 * One session at a time, which is what the native side keeps.
 */
class NativeSession(private val listener: Listener) {

    interface Listener {
        /** One encoded frame, Annex B, as the console sent it. */
        fun onVideo(frame: ByteArray, keyFrame: Boolean, timestampUs: Long)
        fun onAudioHeader(channels: Int, rate: Int, frameSize: Int)
        fun onAudio(packet: ByteArray)
        fun onConnected()
        fun onQuit(reason: String?)
        fun onLog(message: String)
    }

    /** Buttons as libchiaki numbers them; the UI maps its own to these. */
    object Button {
        const val CROSS = 1 shl 26
        const val MOON = 1 shl 27
        const val BOX = 1 shl 28
        const val PYRAMID = 1 shl 29
        const val DPAD_LEFT = 1 shl 31
        const val DPAD_RIGHT = 1 shl 30
        const val DPAD_UP = 1 shl 20
        const val DPAD_DOWN = 1 shl 21
        const val L1 = 1 shl 10
        const val R1 = 1 shl 11
        const val L3 = 1 shl 1
        const val R3 = 1 shl 2
        const val OPTIONS = 1 shl 3
        const val SHARE = 1 shl 4
        const val TOUCHPAD = 1 shl 20 shl 1
        const val PS = 1 shl 0
    }

    @Volatile var buttons: Int = 0
    @Volatile var l2: Int = 0
    @Volatile var r2: Int = 0
    @Volatile var leftX: Int = 0
    @Volatile var leftY: Int = 0
    @Volatile var rightX: Int = 0
    @Volatile var rightY: Int = 0

    fun start(host: String, registKey: String, morning: String, ps4: Boolean,
              width: Int = 1280, height: Int = 720, fps: Int = 60, bitrateKbps: Int = 15000): Int =
        nativeStart(host, registKey, morning, ps4, width, height, fps, bitrateKbps)

    fun stop() = nativeStop()

    /** Push the current pad state to the console. */
    fun sendControllerState() =
        nativeSetControllerState(buttons, l2, r2, leftX, leftY, rightX, rightY)

    fun requestIdr() = nativeRequestIdr()

    // Called from libchiaki's own threads.
    @Suppress("unused")
    private fun onVideo(frame: ByteArray, keyFrame: Boolean, timestampUs: Long) =
        listener.onVideo(frame, keyFrame, timestampUs)

    @Suppress("unused")
    private fun onAudioHeader(channels: Int, rate: Int, frameSize: Int) =
        listener.onAudioHeader(channels, rate, frameSize)

    @Suppress("unused")
    private fun onAudio(packet: ByteArray) = listener.onAudio(packet)

    @Suppress("unused")
    private fun onEvent(kind: Int, text: String?) {
        when (kind) {
            EVENT_CONNECTED -> listener.onConnected()
            EVENT_QUIT -> listener.onQuit(text)
            else -> listener.onLog(text.orEmpty())
        }
    }

    private external fun nativeStart(host: String, registKey: String, morning: String, ps4: Boolean,
                                     width: Int, height: Int, fps: Int, bitrate: Int): Int
    private external fun nativeStop()
    private external fun nativeSetControllerState(buttons: Int, l2: Int, r2: Int,
                                                  lx: Int, ly: Int, rx: Int, ry: Int)
    private external fun nativeRequestIdr()

    companion object {
        private const val EVENT_CONNECTED = 0
        private const val EVENT_QUIT = 1

        /** True when the native session is usable in this build. */
        val available: Boolean = runCatching { System.loadLibrary("p5rp_jni") }.isSuccess
    }
}
