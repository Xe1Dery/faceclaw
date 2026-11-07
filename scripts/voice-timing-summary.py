#!/usr/bin/env python3
"""Summarize metadata-only VoiceTiming Logcat records. Uses native monotonic timestamps."""
import argparse
import json
import re
import statistics
from pathlib import Path


def summarize(lines):
    captures = []
    current = None
    wake = None
    for line in lines:
        if 'VoiceTiming' not in line:
            continue
        fields = dict(re.findall(r'(\w+)=([\w.-]+)', line))
        if 'atMs' not in fields or 'stage' not in fields:
            continue
        at = int(fields['atMs'])
        stage = fields['stage']
        if stage == 'wake_received':
            wake = at
            continue
        if stage == 'capture_requested':
            current = {'capture': fields.get('capture'), 'capture_requested': at}
            # Associate only nearby wake events; phone/PTT captures need no wake.
            if wake is not None and 0 <= at - wake <= 10000:
                current['wake_received'] = wake
            wake = None
            captures.append(current)
        elif current is not None and fields.get('capture') == current['capture']:
            current.setdefault(stage, at)
    pairs = {
        'request_to_first_packet_ms': ('capture_requested', 'first_packet'),
        'wake_to_request_ms': ('wake_received', 'capture_requested'),
        'wake_to_first_packet_ms': ('wake_received', 'first_packet'),
        'recognizer_prepare_ms': ('recognizer_start', 'recognizer_ready'),
        'decoder_prepare_ms': ('decoder_start', 'decoder_ready'),
        'audio_enable_ack_ms': ('audio_enable_start', 'audio_enable_return'),
        'enable_to_first_packet_ms': ('audio_enable_start', 'first_packet'),
    }
    rows = []
    metrics = {key: [] for key in pairs}
    for capture in captures:
        row = {'capture': capture['capture']}
        for key, (start, end) in pairs.items():
            if start in capture and end in capture:
                value = capture[end] - capture[start]
                row[key] = value
                metrics[key].append(value)
        rows.append(row)
    summary = {}
    for key, values in metrics.items():
        if values:
            ordered = sorted(values)
            summary[key] = {'n': len(values), 'median': statistics.median(values),
                            'p95': ordered[max(0, (95 * len(ordered) + 99) // 100 - 1)]}
    return {'captures': rows, 'summary': summary}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('log', type=Path)
    args = parser.parse_args()
    print(json.dumps(summarize(args.log.read_text().splitlines()), indent=2))
