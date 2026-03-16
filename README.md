# War Room (React + Express)

Tactical dashboard with:
- Altitude, SpO2, blood oxygen level
- No. of soldiers and coordinates
- Floor-based marker shape (`0 => dot`, `>0 => triangle`)
- Status colors (`injured=yellow`, `dead=white`, `healthy=green`, `tampered=red`)
- Engage/Fire indicators
- HTTP routes for raw and filtered data

## Run

1. Install dependencies:
   - `npm install`
   - `npm install --prefix server`
   - `npm install --prefix client`
2. Start both API and UI:
   - `npm run dev`

UI: `http://localhost:5173`
API: `http://localhost:4000`

## API Routes

- `GET /health`
- `GET /routes`
- `GET /metrics`
- `GET /soldiers/raw`
- `GET /soldiers`
- `GET /soldiers/status/:status`
- `GET /soldiers/:id`
- `POST /soldiers/:id/engage`
- `POST /soldiers/:id/fire`
- `POST /audio/detect-firing`
- `POST /watch/audio-event`
- `POST /watch/threat-assessment`
- `POST /bluetooth/audio-event`
- `POST /bluetooth/threat-assessment`

### Audio Detection API

Endpoint: `POST /audio/detect-firing`

Request body (either format):
- WAV base64:
```json
{
  "audioBase64": "UklGRiQAAABXQVZF..."
}
```
- Raw samples:
```json
{
  "sampleRate": 16000,
  "samples": [0.01, -0.03, 0.12]
}
```

Response:
```json
{
  "result": "yes(ak47)"
}
```
or
```json
{
  "result": "no"
}
```

## Train ML Models

1. Add your WAV data under:
   - `ml/dataset/gunshot/<gun_name>/*.wav`
   - `ml/dataset/nongunshot/**/*.wav`
2. Train and export artifacts:
   - `npm run train:audio-model`
3. Generated files:
   - `server/models/detector.json`
   - `server/models/classifier.json`

The API route `POST /audio/detect-firing` automatically uses trained artifacts when available.

## Watch Integration

Use `POST /watch/audio-event` when audio comes from tactic watch API.

Request:
```json
{
  "watchId": "WATCH-ALPHA-01",
  "audioBase64": "UklGRiQAAABXQVZF...",
  "callbackUrl": "https://watch-gateway.example.com/detection"
}
```

or:
```json
{
  "watchId": "WATCH-ALPHA-01",
  "sampleRate": 16000,
  "samples": [0.1, -0.1, 0.2]
}
```

Response:
```json
{
  "watchId": "WATCH-ALPHA-01",
  "result": "yes(ak47)"
}
```
or
```json
{
  "watchId": "WATCH-ALPHA-01",
  "result": "no"
}
```

### Threat Assessment API

Use `POST /watch/threat-assessment` to compare detected gun with soldier's gun.

Request:
```json
{
  "watchId": "WATCH-ALPHA-01",
  "soldierGunName": "sniper",
  "audioBase64": "UklGRiQAAABXQVZF..."
}
```

Example response:
```json
{
  "watchId": "WATCH-ALPHA-01",
  "soldierGunName": "sniper",
  "result": "yes(ak47)",
  "assessment": {
    "threat": "confirmed_enemy_fire",
    "source": "enemy",
    "reason": "Detected gun ak47 differs from soldier gun sniper."
  },
  "diagnostics": {
    "peak": 0.9912,
    "rms": 0.1841,
    "proximity": "medium"
  }
}
```

## Bluetooth Audio Integration

When audio comes from a Bluetooth gateway (instead of network JSON), use:

- `POST /bluetooth/audio-event`
- `POST /bluetooth/threat-assessment`

### Binary WAV upload (recommended)

```bash
curl -X POST http://localhost:4000/bluetooth/audio-event \
  -H "Content-Type: audio/wav" \
  -H "X-Watch-Id: WATCH-ALPHA-01" \
  --data-binary @/path/to/audio.wav
```

Threat assessment with soldier weapon:

```bash
curl -X POST http://localhost:4000/bluetooth/threat-assessment \
  -H "Content-Type: audio/wav" \
  -H "X-Watch-Id: WATCH-ALPHA-01" \
  -H "X-Session-Id: WATCH-ALPHA-01-SESSION" \
  -H "X-Soldier-Gun-Name: ak47" \
  --data-binary @/path/to/audio.wav
```

### Raw PCM16 upload

If gateway streams PCM16 bytes:
- set `Content-Type: application/octet-stream`
- set `X-Audio-Format: pcm16`
- set `X-Sample-Rate` and optional `X-Channels`

```bash
curl -X POST http://localhost:4000/bluetooth/audio-event \
  -H "Content-Type: application/octet-stream" \
  -H "X-Audio-Format: pcm16" \
  -H "X-Sample-Rate: 16000" \
  -H "X-Channels: 1" \
  --data-binary @/path/to/audio.pcm
```

### Explicit capture in app/gateway

Use the provided script to capture audio from device/gateway (including earbuds monitor source) and POST continuously:

```bash
python3 gateway/capture_and_post.py \
  --endpoint http://localhost:4000/bluetooth/threat-assessment \
  --watch-id WATCH-BT-01 \
  --session-id WATCH-BT-01-SESSION \
  --soldier-gun-name ak47 \
  --ffmpeg-format pulse \
  --ffmpeg-input bluez_output.XX_XX_XX_XX_XX_XX.1.monitor
```

Detailed steps: [gateway/README.md](/home/adityacoderr/Desktop/codes/war-room/gateway/README.md)

For chunked efficiency:
- keep a stable `X-Session-Id` for one live stream
- response returns both `chunk` and smoothed `aggregated` result

## Smoke Test

Run end-to-end API smoke checks (server startup, watch routes, bluetooth chunk routes):

```bash
npm run smoke:test
```

This script uses:
- `pistol.mp3`
- `gun.mp3`
