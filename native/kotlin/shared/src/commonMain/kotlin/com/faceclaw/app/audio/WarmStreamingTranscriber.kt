package com.faceclaw.app

/** One online recognizer, exclusively leased to a session and reset before it is cached. */
class WarmStreamingTranscriber(platform: ProtocolPlatform = protocolPlatform()) {
    private val lock = platform.createLock()
    private var cached: StreamingTranscriber? = null
    private var cachedKey: String? = null
    private var leased = false
    private var generation = 0L
    private var invalidated = false
    private var closed = false

    fun acquire(key: String, load: () -> StreamingTranscriber): StreamingTranscriber {
        var old: StreamingTranscriber? = null
        var value: StreamingTranscriber? = null
        var loadGeneration = 0L
        lock.withLock {
            check(!closed) { "Recognizer cache is closed" }
            check(!leased) { "Recognizer is still in use" }
            leased = true
            loadGeneration = generation
            if (cachedKey == key) value = cached else {
                old = cached
                cached = null
                cachedKey = null
            }
        }
        try {
            old?.release()
            if (value == null) value = load()
            value.reset()
        } catch (error: Throwable) {
            lock.withLock { leased = false }
            throw error
        }
        val delegate = value
        lock.withLock {
            cached = delegate
            cachedKey = key
            invalidated = closed || generation != loadGeneration
        }
        return object : StreamingTranscriber {
            private var returned = false

            override fun accept(samples: FloatArray, count: Int): StreamingRecognition {
                check(!returned)
                return guarded { delegate.accept(samples, count) }
            }

            override fun finish(): StreamingRecognition {
                check(!returned)
                return guarded { delegate.finish() }
            }

            override fun reset() {
                check(!returned)
                guarded { delegate.reset() }
            }

            override fun release() {
                var dispose: StreamingTranscriber? = null
                try {
                    if (!returned) delegate.reset()
                } catch (_: Throwable) {
                    invalidate()
                }
                lock.withLock {
                    if (returned) return
                    returned = true
                    leased = false
                    if (invalidated || closed) {
                        dispose = cached
                        cached = null
                        cachedKey = null
                    }
                }
                dispose?.release()
            }

            private fun <T> guarded(action: () -> T): T = try {
                action()
            } catch (error: Throwable) {
                invalidate()
                throw error
            }
        }
    }

    fun invalidate() = discard(false)

    fun close() = discard(true)

    private fun discard(permanently: Boolean) {
        var dispose: StreamingTranscriber? = null
        lock.withLock {
            closed = closed || permanently
            generation++
            invalidated = true
            if (!leased) {
                dispose = cached
                cached = null
                cachedKey = null
            }
        }
        dispose?.release()
    }
}
