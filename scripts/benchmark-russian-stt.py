#!/usr/bin/env python3
"""Small reproducible host benchmark for Faceclaw's Russian on-device STT models."""

import argparse
import json
import time
import wave
from pathlib import Path

import numpy as np
import psutil
import sherpa_onnx


def read_wave(path: Path):
    with wave.open(str(path), "rb") as source:
        if source.getnchannels() != 1 or source.getsampwidth() != 2:
            raise ValueError(f"{path}: expected mono PCM16 WAV")
        rate = source.getframerate()
        samples = np.frombuffer(source.readframes(source.getnframes()), dtype=np.int16)
    return samples.astype(np.float32) / 32768.0, rate


def rss_mb():
    return round(psutil.Process().memory_info().rss / 1024 / 1024, 1)


def zipformer(model: Path, waves):
    baseline_rss = rss_mb()
    started = time.perf_counter()
    recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
        encoder=str(model / "encoder.int8.onnx"),
        decoder=str(model / "decoder.onnx"),
        joiner=str(model / "joiner.int8.onnx"),
        tokens=str(model / "tokens.txt"),
        num_threads=2,
        enable_endpoint_detection=True,
        decoding_method="greedy_search",
        model_type="zipformer2",
        provider="cpu",
    )
    load_seconds = time.perf_counter() - started
    model_rss = rss_mb()
    results = []
    for path in waves:
        samples, rate = read_wave(path)
        stream = recognizer.create_stream()
        chunk = rate // 20
        transitions = []
        committed = []
        current = ""
        last = ""
        first_partial = None
        wall_started = time.perf_counter()
        cpu_started = time.process_time()
        for offset in range(0, samples.size, chunk):
            end = min(samples.size, offset + chunk)
            stream.accept_waveform(rate, samples[offset:end])
            while recognizer.is_ready(stream):
                recognizer.decode_stream(stream)
            raw = str(recognizer.get_result(stream)).strip()
            if raw:
                current = raw
            text = " ".join(committed + ([current] if current else []))
            audio_seconds = end / rate
            if text and text != last:
                first_partial = audio_seconds if first_partial is None else first_partial
                transitions.append({"audio_s": round(audio_seconds, 2), "text": text})
                last = text
            if recognizer.is_endpoint(stream):
                if current:
                    committed.append(current)
                    current = ""
                recognizer.reset(stream)
        stream.input_finished()
        while recognizer.is_ready(stream):
            recognizer.decode_stream(stream)
        raw = str(recognizer.get_result(stream)).strip()
        if raw:
            current = raw
        final = " ".join(committed + ([current] if current else [])) or last
        wall_seconds = time.perf_counter() - wall_started
        cpu_seconds = time.process_time() - cpu_started
        audio_seconds = samples.size / rate
        results.append({
            "wav": str(path),
            "audio_s": round(audio_seconds, 3),
            "first_partial_audio_s": first_partial,
            "wall_s": round(wall_seconds, 3),
            "cpu_s": round(cpu_seconds, 3),
            "rtf": round(wall_seconds / audio_seconds, 3),
            "final": final,
            "partials": transitions,
            "rss_after_mb": rss_mb(),
        })
    return {
        "engine": "zipformer",
        "load_s": round(load_seconds, 3),
        "baseline_rss_mb": baseline_rss,
        "model_rss_mb": model_rss,
        "model_rss_delta_mb": round(model_rss - baseline_rss, 1),
        "results": results,
    }


def whisper(model: Path, waves):
    baseline_rss = rss_mb()
    started = time.perf_counter()
    recognizer = sherpa_onnx.OfflineRecognizer.from_whisper(
        encoder=str(model / "base-encoder.int8.onnx"),
        decoder=str(model / "base-decoder.int8.onnx"),
        tokens=str(model / "base-tokens.txt"),
        language="ru",
        task="transcribe",
        num_threads=1,
        provider="cpu",
    )
    load_seconds = time.perf_counter() - started
    model_rss = rss_mb()
    results = []
    for path in waves:
        samples, rate = read_wave(path)
        stream = recognizer.create_stream()
        stream.accept_waveform(rate, samples)
        wall_started = time.perf_counter()
        cpu_started = time.process_time()
        recognizer.decode_stream(stream)
        wall_seconds = time.perf_counter() - wall_started
        cpu_seconds = time.process_time() - cpu_started
        audio_seconds = samples.size / rate
        results.append({
            "wav": str(path),
            "audio_s": round(audio_seconds, 3),
            "first_partial_audio_s": None,
            "wall_s": round(wall_seconds, 3),
            "cpu_s": round(cpu_seconds, 3),
            "rtf": round(wall_seconds / audio_seconds, 3),
            "final": stream.result.text.strip(),
            "partials": [],
            "rss_after_mb": rss_mb(),
        })
    return {
        "engine": "whisper",
        "load_s": round(load_seconds, 3),
        "baseline_rss_mb": baseline_rss,
        "model_rss_mb": model_rss,
        "model_rss_delta_mb": round(model_rss - baseline_rss, 1),
        "results": results,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("engine", choices=("zipformer", "whisper"))
    parser.add_argument("model", type=Path)
    parser.add_argument("waves", type=Path, nargs="+")
    args = parser.parse_args()
    run = zipformer if args.engine == "zipformer" else whisper
    print(json.dumps(run(args.model, args.waves), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
