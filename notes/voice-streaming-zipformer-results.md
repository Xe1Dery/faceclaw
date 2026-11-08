# Russian streaming STT experiment

Measured on 2026-11-08 with sherpa-onnx 1.13.0 on Windows x86-64. This is a
host-side comparison, not a substitute for measurements on the Android phone and real G2 audio.
The benchmark is reproducible with `scripts/benchmark-russian-stt.py`.

Models:

- Streaming Zipformer Small RU INT8, pinned at `31fa603e4f31279c6e1f7600fed13dc4312663ab`.
- The existing offline Whisper multilingual base INT8, pinned at
  `bb53ee204431c90d314c1cc08d28d23e5b7927cc` with language `ru`.

Two official Zipformer test WAVs were used. Case and punctuation are ignored for the small word
error comparison. The second reference is the Mamin-Sibiryak sentence beginning “Родион Потапыч
высчитывал каждый новый вершок углубления и давно определил про себя”.

| Metric | Zipformer | Whisper multilingual |
| --- | ---: | ---: |
| First live text | 0.8 s on the continuous sentence; 5.3 s on the sparse/short sample | None before finalization |
| Final text, short sample | `я тебя люблю` | `Я тебя люблю` |
| Errors on 12-word sentence | omitted `про себя` (2 deletions) | `Патапыч` for `Потапыч` (1 substitution) |
| Aggregate WER on these 15 words | 13.3% | 6.7% |
| Real-time factor | 0.042 / 0.042 | 0.144 / 0.299 |
| CPU seconds | 0.875 / 0.875 | 1.328 / 2.109 |
| Model-load RSS delta | 78.5 MB | 198.9 MB |
| RSS after decode | about 125 MB | about 409 MB |

The sample is far too small to claim general accuracy. It does show the intended UX: the second
utterance progressed through `родион`, `родион потапыч`, `... высчитывал`, and the rest while audio
was still arriving. Whisper was somewhat more accurate on the literary sentence and supplied case
and punctuation, but returned nothing until the complete buffer was decoded. Zipformer is kept as
an experimental separate provider; Whisper remains available and is not replaced.

T-One CTC was reviewed but not integrated. Its current export is one 144,193,702-byte ONNX file
plus tokens (about five times Zipformer's 28,572,945-byte download), and sherpa-onnx 1.13.0 exposes
it through `OnlineToneCtcModelConfig`. A real G2 corpus should establish that Zipformer is
materially inadequate before paying that storage/RAM cost.

## Real G2 acceptance test

1. In Settings > Voice, download **Zipformer Streaming (Russian, small INT8)** and select
   **On-device (Zipformer Russian, streaming)**.
2. Dictate at least 20 natural Russian phrases: short commands, names, numbers, and 10–20 second
   sentences. Confirm that text grows before button release and that no word is duplicated when
   an internal endpoint commits.
3. Cancel a phrase midway, immediately start another, and repeat several times. The next phrase
   must not contain text from the previous stream.
4. Capture diagnostics with `adb logcat -s FaceclawVoice`. `Zipformer firstPartialMs` measures
   visible latency; `ZipformerPerf` reports audio duration, decode time, and Java heap. Use
   `adb shell dumpsys meminfo com.faceclaw.app` for total process memory.
5. Repeat the same recorded phrase set with Whisper multilingual and calculate normalized WER.
   Only then decide whether to prototype T-One.

The csukuangfj Zipformer mirror currently has no explicit license metadata in its model card,
although it points to the Apache-2.0 upstream Alpha Cephei model. The weights are downloaded by the
user and are not included in the APK; clarify the mirror's licensing before redistributing weights.
