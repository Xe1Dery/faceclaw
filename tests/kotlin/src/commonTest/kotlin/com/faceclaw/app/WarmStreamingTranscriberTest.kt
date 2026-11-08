package com.faceclaw.app

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class WarmStreamingTranscriberTest {
    private class Model : StreamingTranscriber {
        var resets = 0
        var releases = 0

        override fun accept(samples: FloatArray, count: Int) = StreamingRecognition("текст")
        override fun finish() = StreamingRecognition("готово")
        override fun reset() { resets++ }
        override fun release() { releases++ }
    }

    @Test fun repeatedSessionsReuseWeightsAndResetStreamState() {
        val cache = WarmStreamingTranscriber(testPlatform())
        val model = Model()
        var loads = 0
        repeat(3) {
            val lease = cache.acquire("zipformer") { loads++; model }
            assertEquals("текст", lease.accept(floatArrayOf(1f), 1).text)
            lease.release()
            lease.release()
        }
        assertEquals(1, loads)
        assertEquals(6, model.resets)
        assertEquals(0, model.releases)
        cache.close()
        assertEquals(1, model.releases)
        assertFailsWith<IllegalStateException> { cache.acquire("zipformer") { Model() } }
    }

    @Test fun decodeFailureEvictsRecognizerAfterLeaseReturns() {
        val cache = WarmStreamingTranscriber(testPlatform())
        var releases = 0
        val lease = cache.acquire("bad") {
            object : StreamingTranscriber {
                override fun accept(samples: FloatArray, count: Int): StreamingRecognition = error("decode failed")
                override fun finish() = StreamingRecognition("")
                override fun reset() {}
                override fun release() { releases++ }
            }
        }
        assertFailsWith<IllegalStateException> { lease.accept(floatArrayOf(1f), 1) }
        lease.release()
        assertEquals(1, releases)
    }
}
