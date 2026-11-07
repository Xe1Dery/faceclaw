package com.faceclaw.app

/** One recognizer, exclusively leased to a worker. Native release never races decode or load. */
class WarmTranscriber(platform: ProtocolPlatform = protocolPlatform()) {
    private val lock = platform.createLock()
    private var cached: OfflineTranscriber? = null
    private var cachedKey: String? = null
    private var leased = false
    private var generation = 0L
    private var invalidated = false
    private var closed = false

    fun acquire(key: String, load: () -> OfflineTranscriber): OfflineTranscriber {
        var old: OfflineTranscriber? = null
        var value: OfflineTranscriber? = null
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
        return object : OfflineTranscriber {
            private var returned = false
            override fun recognize(samples: FloatArray, count: Int): String {
                check(!returned)
                try {
                    return delegate.recognize(samples, count)
                } catch (error: Throwable) {
                    invalidate()
                    throw error
                }
            }
            override fun release() {
                var dispose: OfflineTranscriber? = null
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
        }
    }

    /** Active leases remain valid; they are destroyed when returned instead of being cached. */
    fun invalidate() = discard(false)

    fun close() = discard(true)

    private fun discard(permanently: Boolean) {
        var dispose: OfflineTranscriber? = null
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
