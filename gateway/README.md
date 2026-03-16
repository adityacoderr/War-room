# Gateway Capture And POST

This script explicitly captures audio in a gateway/app process and POSTs chunks to war-room API.

## 1) Start API

```bash
npm run dev:server
```

## 2) Find bluetooth playback monitor source (Linux PulseAudio)

```bash
pactl list short sources | grep -i monitor
```

Pick your earbuds monitor source, typically like:
- `bluez_output.<device_id>.monitor`

## 3) Stream capture to threat endpoint

```bash
python3 gateway/capture_and_post.py \
  --endpoint http://localhost:4000/bluetooth/threat-assessment \
  --watch-id WATCH-BT-01 \
  --session-id WATCH-BT-01-SESSION \
  --soldier-gun-name ak47 \
  --ffmpeg-format pulse \
  --ffmpeg-input bluez_output.XX_XX_XX_XX_XX_XX.1.monitor
```

## 4) Stream capture to simple firing endpoint

```bash
python3 gateway/capture_and_post.py \
  --endpoint http://localhost:4000/bluetooth/audio-event \
  --watch-id WATCH-BT-01 \
  --session-id WATCH-BT-01-SESSION \
  --ffmpeg-format pulse \
  --ffmpeg-input bluez_output.XX_XX_XX_XX_XX_XX.1.monitor
```

## Notes

- Captured chunks are PCM16 and sent as `application/octet-stream`.
- Headers sent automatically: `X-Audio-Format`, `X-Sample-Rate`, `X-Channels`, `X-Watch-Id`, `X-Session-Id`.
- Server smooths decisions over recent chunks in the same session (`X-Session-Id`).
- For lower compute, start with `--chunk-seconds 1.0` and increase to `1.5` if needed.
- Stop with `Ctrl+C`.
