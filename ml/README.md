# Audio ML Pipeline

This folder contains a trainable ML pipeline for:
- gunshot detection (binary)
- gun type classification (multiclass)

## Dataset layout

Create WAV datasets in:

```text
ml/dataset/
  gunshot/
    ak47/*.wav
    m16/*.wav
    glock/*.wav
    shotgun/*.wav
  nongunshot/
    *.wav
    fireworks/*.wav
    car_backfire/*.wav
    door_slam/*.wav
```

Notes:
- WAV only
- any sample rate is accepted (auto-resampled to 16kHz)
- any channel count is accepted (auto-converted to mono)
- each clip is normalized and trimmed/padded to 2 seconds

## Train and export models

From repo root:

```bash
python3 ml/train_models.py
```

Artifacts generated:
- `server/models/detector.json`
- `server/models/classifier.json`

These are loaded automatically by `server/audioInference.js` at runtime.

