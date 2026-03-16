#!/usr/bin/env python3
"""
Capture audio in a gateway/app process and POST PCM16 chunks to war-room API.

Typical usage for bluetooth playback monitor on Linux PulseAudio:
  python3 gateway/capture_and_post.py \
    --endpoint http://localhost:4000/bluetooth/threat-assessment \
    --watch-id WATCH-BT-01 \
    --soldier-gun-name ak47 \
    --ffmpeg-format pulse \
    --ffmpeg-input bluez_output.XX_XX_XX_XX_XX_XX.1.monitor
"""

from __future__ import annotations

import argparse
import json
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--endpoint",
        default="http://localhost:4000/bluetooth/threat-assessment",
        help="Target API endpoint",
    )
    parser.add_argument("--watch-id", default="WATCH-BT-01")
    parser.add_argument("--session-id", default="", help="Chunk stream session id (defaults to watch-id)")
    parser.add_argument("--soldier-gun-name", default="", help="Used by threat-assessment endpoint")
    parser.add_argument("--audio-format", default="pcm16", choices=["pcm16"])
    parser.add_argument("--sample-rate", type=int, default=16000)
    parser.add_argument("--channels", type=int, default=1)
    parser.add_argument("--chunk-seconds", type=float, default=1.0)
    parser.add_argument("--timeout-seconds", type=float, default=5.0)
    parser.add_argument(
        "--ffmpeg-format",
        default="pulse",
        help="ffmpeg input format: pulse/alsa/avfoundation/dshow/etc",
    )
    parser.add_argument(
        "--ffmpeg-input",
        default="default",
        help="ffmpeg input device/source (for pulse: default or monitor source name)",
    )
    return parser.parse_args()


def build_ffmpeg_command(args: argparse.Namespace) -> list[str]:
    return [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        args.ffmpeg_format,
        "-i",
        args.ffmpeg_input,
        "-ac",
        str(args.channels),
        "-ar",
        str(args.sample_rate),
        "-f",
        "s16le",
        "pipe:1",
    ]


def post_chunk(
    endpoint: str,
    chunk: bytes,
    watch_id: str,
    session_id: str,
    soldier_gun_name: str,
    sample_rate: int,
    channels: int,
    timeout_seconds: float,
) -> tuple[bool, str]:
    headers = {
        "Content-Type": "application/octet-stream",
        "X-Audio-Format": "pcm16",
        "X-Watch-Id": watch_id,
        "X-Session-Id": session_id,
        "X-Sample-Rate": str(sample_rate),
        "X-Channels": str(channels),
    }
    if soldier_gun_name:
        headers["X-Soldier-Gun-Name"] = soldier_gun_name

    req = urllib.request.Request(endpoint, data=chunk, method="POST", headers=headers)

    try:
        with urllib.request.urlopen(req, timeout=timeout_seconds) as response:
            body = response.read().decode("utf-8", errors="replace")
            return True, body
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        return False, f"HTTP {exc.code}: {body}"
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)


def main() -> int:
    args = parse_args()
    if args.sample_rate <= 0:
        print("sample-rate must be > 0", file=sys.stderr)
        return 2
    if args.channels <= 0:
        print("channels must be > 0", file=sys.stderr)
        return 2
    if args.chunk_seconds <= 0:
        print("chunk-seconds must be > 0", file=sys.stderr)
        return 2

    bytes_per_sample = 2  # PCM16
    chunk_size = int(args.sample_rate * args.channels * bytes_per_sample * args.chunk_seconds)
    if chunk_size <= 0:
        print("invalid chunk size", file=sys.stderr)
        return 2

    cmd = build_ffmpeg_command(args)
    print("Starting capture:", " ".join(cmd))
    print("Posting to:", args.endpoint)

    stop = False

    def handle_signal(_sig: int, _frame: object) -> None:
        nonlocal stop
        stop = True

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert process.stdout is not None

    sent = 0
    started = time.time()

    try:
        while not stop:
            chunk = process.stdout.read(chunk_size)
            if not chunk:
                time.sleep(0.05)
                if process.poll() is not None:
                    break
                continue

            ok, response_text = post_chunk(
                endpoint=args.endpoint,
                chunk=chunk,
                watch_id=args.watch_id,
                session_id=args.session_id or args.watch_id,
                soldier_gun_name=args.soldier_gun_name,
                sample_rate=args.sample_rate,
                channels=args.channels,
                timeout_seconds=args.timeout_seconds,
            )

            sent += 1
            prefix = "[ok]" if ok else "[err]"
            print(f"{prefix} chunk={sent} response={response_text}")
    finally:
        stop = True
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()

    elapsed = max(0.001, time.time() - started)
    print(f"Stopped. chunks_sent={sent} duration_sec={elapsed:.2f} avg_chunk_rate={sent/elapsed:.2f}/s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
