# Voice interface audit (before implementation)

Baseline: b353483ac2a7f4b0f1cc69613bbebd48cd3163d7.

## Current architecture

* The dashboard configures a process-wide AssistantBridgeClient. It uses the native OkHttp wrapper, authenticates with a token in a hello frame and reconnects with exponential backoff. URL construction hardcodes ws. Host/port/token are persisted ConfigSettings. OkHttp already uses the Android trust store and hostname verifier.
* G2 firmware detects Hey Even. BLE event delivery, TypeScript shell activation and native capture startup precede microphone enable. VoiceCaptureSession runs on a worker, synchronously loads sherpa before starting G2 audio, then consumes a bounded packet queue. LC3 decode is separate from STT. The phone-mic path uses AudioRecord.
* AndroidSpeechEngines creates a new sherpa OfflineRecognizer for every session. Each decode creates/releases its own OfflineStream. The session releases the recognizer at exit. Moonshine has segmented live partials; Whisper base.en decodes only at segment/final boundaries. Both installed models are English-only. Downloads already resume and verify pinned per-file SHA-256 before rename.
* Native session start can overlap a previous worker that is finishing after stop's 1.5 s timeout. Packet-source stop currently resolves the current communicator rather than the source that started capture. Transcript previews currently reach Logcat.
* Tests: Node/TypeScript tests, shared Kotlin host tests through wear/gradlew, NativeScript Android APK build with SDK 35, NDK and sherpa 1.13.0. No Android device or G2 is attached to this workspace.

## Measurable hypotheses (no hardware measurements yet)

1. Repeated model construction is an avoidable serial cost before microphone enable. Measure recognizer preparation start/end for cold and warm calls.
2. BLE microphone enable/first packet and decoder construction contribute independently. Measure capture request, decoder ready, enable request/return and first packet using elapsedRealtime, plus native wake event receipt.
3. UI/BLE event handling can contribute before native capture start. Compare the wake timestamp with capture request; firmware wake detection before phone receipt cannot be measured with phone logs alone.
4. Early G2 packet buffering can hide cold STT preparation. Bound memory, retain FIFO order, and fail explicitly if preparation outlasts capacity; never silently submit speech with missing leading packets.

## Minimal changes

1. WS/WSS persisted selection, scheme-specific automatic ports preserving explicit legacy ports, input validation, reconnect callback ownership, Nginx example. Keep hello authorization and system TLS validation, disallow redirects/downgrade.
2. Android-owned, single-entry leased warm recognizer; keep per-decode streams ephemeral. Invalidate on model/language change, memory pressure and close, deferring release until active worker returns the lease. Start G2 before STT load; guard worker ownership and cancellation. Add metadata-only monotonic timing and remove transcript preview logging.
3. Add multilingual Whisper base int8 using the existing sherpa backend and downloader, with Russian/English/automatic language selection; retain English base.en and Moonshine. Base is a starting size/accuracy compromise; actual Russian/mixed-language quality and end-to-end latency need phone/G2 evaluation before recommending a larger model or GigaAM.
4. Add deterministic regression tests and device measurement instructions. Report build/toolchain limits and leave real-device results explicitly unmeasured when unavailable.
