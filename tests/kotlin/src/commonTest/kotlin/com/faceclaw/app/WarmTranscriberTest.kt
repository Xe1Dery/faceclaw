package com.faceclaw.app

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class WarmTranscriberTest {
    private class Model : OfflineTranscriber {
        var releases = 0
        override fun recognize(samples: FloatArray, count: Int): String {
            check(releases == 0)
            return "готово"
        }
        override fun release() { releases++ }
    }

    @Test fun repeatedSessionsReuseWeightsButLanguageChangeReleasesExactlyOnce() {
        val cache = WarmTranscriber(testPlatform())
        val ru = Model()
        var loads = 0
        repeat(3) {
            val lease = cache.acquire("base:ru") { loads++; ru }
            assertEquals("готово", lease.recognize(floatArrayOf(1f), 1))
            lease.release()
            lease.release()
        }
        assertEquals(1, loads)
        assertEquals(0, ru.releases)
        val en = Model()
        val lease = cache.acquire("base:en") { en }
        assertEquals(1, ru.releases)
        lease.release()
        cache.close()
        cache.close()
        assertEquals(1, en.releases)
        assertFailsWith<IllegalStateException> { cache.acquire("base:en") { Model() } }
    }

    @Test fun memoryPressureAndCloseDuringDecodeDeferNativeRelease() {
        val cache = WarmTranscriber(testPlatform())
        val model = Model()
        val lease = cache.acquire("moonshine") { model }
        cache.invalidate()
        cache.close()
        assertEquals(0, model.releases)
        assertEquals("готово", lease.recognize(floatArrayOf(1f), 1))
        assertFailsWith<IllegalStateException> { cache.acquire("other") { Model() } }
        lease.release()
        assertEquals(1, model.releases)
    }

    @Test fun invalidationDuringLoadDiscardsWeightsOnReturnAndLoadFailureCanRetry() {
        val cache = WarmTranscriber(testPlatform())
        assertFailsWith<IllegalStateException> { cache.acquire("bad") { error("load failed") } }
        val model = Model()
        val lease = cache.acquire("base:auto") { cache.invalidate(); model }
        assertEquals(0, model.releases)
        lease.release()
        assertEquals(1, model.releases)
        val next = Model()
        cache.acquire("base:auto") { next }.release()
        cache.invalidate()
        assertEquals(1, next.releases)
    }

    @Test fun decodeFailureEvictsTheFailedNativeRecognizer() {
        val cache = WarmTranscriber(testPlatform())
        var releases = 0
        val lease = cache.acquire("bad") {
            object : OfflineTranscriber {
                override fun recognize(samples: FloatArray, count: Int): String = error("decode failed")
                override fun release() { releases++ }
            }
        }
        assertFailsWith<IllegalStateException> { lease.recognize(floatArrayOf(1f), 1) }
        assertEquals(0, releases)
        lease.release()
        assertEquals(1, releases)
        cache.acquire("bad") { Model() }.release()
        cache.close()
    }
}
