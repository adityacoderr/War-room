#!/usr/bin/env python3
"""
Train gunshot detector + gun-type classifier and export JSON model artifacts.

Dataset structure:
  ml/dataset/
    gunshot/
      ak47/*.wav
      glock/*.wav
      shotgun/*.wav
      ...
    nongunshot/
      *.wav
      fireworks/*.wav
      car_backfire/*.wav
      ...
"""

from __future__ import annotations

import argparse
import json
import random
import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np

TARGET_SAMPLE_RATE = 16000
WINDOW_SECONDS = 2
WINDOW_SAMPLES = TARGET_SAMPLE_RATE * WINDOW_SECONDS
FEATURE_ORDER = ["peak", "rms", "crest", "transient", "high_amp_ratio", "centroid"]


@dataclass
class Scaler:
    mean: np.ndarray
    std: np.ndarray

    def transform(self, x: np.ndarray) -> np.ndarray:
        return (x - self.mean) / self.std

    def to_json(self) -> dict:
        return {"mean": self.mean.tolist(), "std": self.std.tolist()}


def load_wav_mono(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as wav:
        channels = wav.getnchannels()
        sample_rate = wav.getframerate()
        sample_width = wav.getsampwidth()
        frame_count = wav.getnframes()
        raw = wav.readframes(frame_count)

    if sample_width == 2:
        samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    elif sample_width == 4:
        samples = np.frombuffer(raw, dtype=np.int32).astype(np.float32) / 2147483648.0
    else:
        raise ValueError(f"Unsupported WAV sample width {sample_width} in {path}")

    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)

    return np.clip(samples, -1.0, 1.0), sample_rate


def resample_linear(samples: np.ndarray, source_rate: int, target_rate: int) -> np.ndarray:
    if source_rate == target_rate:
        return samples.astype(np.float32, copy=False)

    if len(samples) == 0:
        return np.zeros(1, dtype=np.float32)

    new_length = max(1, round(len(samples) * (target_rate / source_rate)))
    x_old = np.linspace(0, len(samples) - 1, num=len(samples), dtype=np.float32)
    x_new = np.linspace(0, len(samples) - 1, num=new_length, dtype=np.float32)
    resampled = np.interp(x_new, x_old, samples)
    return resampled.astype(np.float32)


def normalize_to_window(samples: np.ndarray) -> np.ndarray:
    out = np.zeros(WINDOW_SAMPLES, dtype=np.float32)
    usable = min(len(samples), WINDOW_SAMPLES)
    out[:usable] = samples[:usable]
    peak = float(np.max(np.abs(out)))
    if peak > 0:
        out = np.clip(out / peak, -1.0, 1.0)
    return out


def spectral_centroid(samples: np.ndarray, sample_rate: int) -> float:
    frame_size = 1024
    hop = 512
    if len(samples) < frame_size:
        return 0.0

    freqs = np.fft.rfftfreq(frame_size, d=1.0 / sample_rate)
    weighted_sum = 0.0
    mag_sum = 0.0

    for start in range(0, len(samples) - frame_size + 1, hop):
        frame = samples[start : start + frame_size]
        mag = np.abs(np.fft.rfft(frame))
        weighted_sum += float(np.sum(freqs * mag))
        mag_sum += float(np.sum(mag))

    return weighted_sum / mag_sum if mag_sum > 0 else 0.0


def extract_features(samples: np.ndarray) -> np.ndarray:
    peak = float(np.max(np.abs(samples)))
    rms = float(np.sqrt(np.mean(samples * samples)))
    crest = peak / (rms + 1e-6)
    transient = float(np.mean(np.abs(np.diff(samples)))) if len(samples) > 1 else 0.0
    high_amp_ratio = float(np.mean(np.abs(samples) > 0.6))
    centroid = float(spectral_centroid(samples, TARGET_SAMPLE_RATE))
    return np.array([peak, rms, crest, transient, high_amp_ratio, centroid], dtype=np.float32)


def load_feature_from_file(path: Path) -> np.ndarray:
    samples, sample_rate = load_wav_mono(path)
    normalized = normalize_to_window(resample_linear(samples, sample_rate, TARGET_SAMPLE_RATE))
    return extract_features(normalized)


def collect_dataset(dataset_dir: Path) -> tuple[np.ndarray, np.ndarray, np.ndarray, list[str]]:
    gunshot_dir = dataset_dir / "gunshot"
    nongunshot_dir = dataset_dir / "nongunshot"

    if not gunshot_dir.exists() or not nongunshot_dir.exists():
        raise FileNotFoundError(
            "Expected dataset directories: ml/dataset/gunshot and ml/dataset/nongunshot"
        )

    detector_features: list[np.ndarray] = []
    detector_labels: list[int] = []
    classifier_features: list[np.ndarray] = []
    classifier_labels: list[int] = []

    class_names = sorted([p.name for p in gunshot_dir.iterdir() if p.is_dir()])
    if not class_names:
        raise ValueError("No gunshot class folders found under ml/dataset/gunshot")

    for class_index, class_name in enumerate(class_names):
        class_dir = gunshot_dir / class_name
        wav_files = sorted(class_dir.rglob("*.wav"))
        if not wav_files:
            print(f"[warn] no wav files in class {class_name}")
            continue
        for wav_path in wav_files:
            feature = load_feature_from_file(wav_path)
            detector_features.append(feature)
            detector_labels.append(1)
            classifier_features.append(feature)
            classifier_labels.append(class_index)

    nongun_wavs = sorted(nongunshot_dir.rglob("*.wav"))
    if not nongun_wavs:
        raise ValueError("No non-gunshot wav files found under ml/dataset/nongunshot")

    for wav_path in nongun_wavs:
        feature = load_feature_from_file(wav_path)
        detector_features.append(feature)
        detector_labels.append(0)

    return (
        np.array(detector_features, dtype=np.float32),
        np.array(detector_labels, dtype=np.float32),
        np.array(classifier_features, dtype=np.float32),
        np.array(classifier_labels, dtype=np.int64),
        class_names,
    )


def fit_scaler(x_train: np.ndarray) -> Scaler:
    mean = x_train.mean(axis=0)
    std = x_train.std(axis=0)
    std = np.where(std < 1e-6, 1.0, std)
    return Scaler(mean=mean, std=std)


def sigmoid(z: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(z, -30, 30)))


def softmax(logits: np.ndarray) -> np.ndarray:
    shifted = logits - logits.max(axis=1, keepdims=True)
    exp_values = np.exp(shifted)
    return exp_values / exp_values.sum(axis=1, keepdims=True)


def stratified_split_indices(y: np.ndarray, val_ratio: float, seed: int) -> tuple[np.ndarray, np.ndarray]:
    rng = random.Random(seed)
    train_indices: list[int] = []
    val_indices: list[int] = []

    for label in sorted(set(y.tolist())):
        indices = [i for i, value in enumerate(y.tolist()) if value == label]
        rng.shuffle(indices)
        val_count = max(1, int(len(indices) * val_ratio))
        val_indices.extend(indices[:val_count])
        train_indices.extend(indices[val_count:])

    return np.array(train_indices, dtype=np.int64), np.array(val_indices, dtype=np.int64)


def train_binary_logreg(
    x_train: np.ndarray, y_train: np.ndarray, lr: float = 0.05, epochs: int = 900, l2: float = 0.0005
) -> tuple[np.ndarray, float]:
    n_samples, n_features = x_train.shape
    w = np.zeros(n_features, dtype=np.float32)
    b = 0.0

    for _ in range(epochs):
        z = x_train @ w + b
        pred = sigmoid(z)
        error = pred - y_train
        grad_w = (x_train.T @ error) / n_samples + l2 * w
        grad_b = float(np.mean(error))
        w -= lr * grad_w
        b -= lr * grad_b

    return w, b


def train_softmax_logreg(
    x_train: np.ndarray,
    y_train: np.ndarray,
    num_classes: int,
    lr: float = 0.03,
    epochs: int = 1200,
    l2: float = 0.0005,
) -> tuple[np.ndarray, np.ndarray]:
    n_samples, n_features = x_train.shape
    w = np.zeros((num_classes, n_features), dtype=np.float32)
    b = np.zeros(num_classes, dtype=np.float32)

    y_onehot = np.eye(num_classes, dtype=np.float32)[y_train]

    for _ in range(epochs):
        logits = x_train @ w.T + b
        probs = softmax(logits)
        diff = probs - y_onehot
        grad_w = (diff.T @ x_train) / n_samples + l2 * w
        grad_b = diff.mean(axis=0)
        w -= lr * grad_w
        b -= lr * grad_b

    return w, b


def detector_metrics(y_true: np.ndarray, scores: np.ndarray, threshold: float) -> tuple[float, float, float]:
    y_pred = (scores >= threshold).astype(np.float32)
    tp = float(np.sum((y_pred == 1) & (y_true == 1)))
    fp = float(np.sum((y_pred == 1) & (y_true == 0)))
    fn = float(np.sum((y_pred == 0) & (y_true == 1)))

    precision = tp / (tp + fp + 1e-9)
    recall = tp / (tp + fn + 1e-9)
    f1 = (2 * precision * recall) / (precision + recall + 1e-9)
    return precision, recall, f1


def choose_threshold(y_true: np.ndarray, scores: np.ndarray) -> float:
    candidates = np.linspace(0.25, 0.9, num=27)
    best = (0.5, -1.0, -1.0, -1.0)

    for threshold in candidates:
        precision, recall, f1 = detector_metrics(y_true, scores, float(threshold))
        score = f1 if precision >= 0.8 else f1 * 0.8
        if score > best[1]:
            best = (float(threshold), score, precision, recall)

    print(
        f"[detector] chosen threshold={best[0]:.3f}, precision={best[2]:.3f}, recall={best[3]:.3f}"
    )
    return best[0]


def classifier_accuracy(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    if len(y_true) == 0:
        return 0.0
    return float(np.mean(y_true == y_pred))


def ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset-dir", default="ml/dataset", help="Path to dataset root")
    parser.add_argument("--detector-out", default="server/models/detector.json")
    parser.add_argument("--classifier-out", default="server/models/classifier.json")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    dataset_dir = Path(args.dataset_dir)
    detector_out = Path(args.detector_out)
    classifier_out = Path(args.classifier_out)

    x_det, y_det, x_cls, y_cls, class_names = collect_dataset(dataset_dir)
    print(
        f"[dataset] detector samples={len(x_det)} (gunshot={int(y_det.sum())}, nongun={int((y_det==0).sum())})"
    )
    print(f"[dataset] classifier samples={len(x_cls)}, classes={class_names}")

    det_train_idx, det_val_idx = stratified_split_indices(y_det.astype(np.int64), val_ratio=0.2, seed=args.seed)
    x_det_train = x_det[det_train_idx]
    y_det_train = y_det[det_train_idx]
    x_det_val = x_det[det_val_idx]
    y_det_val = y_det[det_val_idx]

    det_scaler = fit_scaler(x_det_train)
    x_det_train_norm = det_scaler.transform(x_det_train)
    x_det_val_norm = det_scaler.transform(x_det_val)

    det_w, det_b = train_binary_logreg(x_det_train_norm, y_det_train)
    det_val_scores = sigmoid(x_det_val_norm @ det_w + det_b)
    det_threshold = choose_threshold(y_det_val, det_val_scores)
    det_precision, det_recall, det_f1 = detector_metrics(y_det_val, det_val_scores, det_threshold)
    print(f"[detector] val precision={det_precision:.3f}, recall={det_recall:.3f}, f1={det_f1:.3f}")

    cls_train_idx, cls_val_idx = stratified_split_indices(y_cls, val_ratio=0.2, seed=args.seed)
    x_cls_train = x_cls[cls_train_idx]
    y_cls_train = y_cls[cls_train_idx]
    x_cls_val = x_cls[cls_val_idx]
    y_cls_val = y_cls[cls_val_idx]

    cls_scaler = fit_scaler(x_cls_train)
    x_cls_train_norm = cls_scaler.transform(x_cls_train)
    x_cls_val_norm = cls_scaler.transform(x_cls_val)

    cls_w, cls_b = train_softmax_logreg(
        x_cls_train_norm, y_cls_train, num_classes=len(class_names), lr=0.03, epochs=1400
    )
    cls_probs = softmax(x_cls_val_norm @ cls_w.T + cls_b)
    cls_pred = np.argmax(cls_probs, axis=1)
    cls_acc = classifier_accuracy(y_cls_val, cls_pred)
    print(f"[classifier] val accuracy={cls_acc:.3f}")

    detector_artifact = {
        "model_type": "logistic_binary",
        "feature_order": FEATURE_ORDER,
        "scaler": det_scaler.to_json(),
        "weights": det_w.tolist(),
        "bias": float(det_b),
        "threshold": float(det_threshold),
        "metrics": {
            "precision": det_precision,
            "recall": det_recall,
            "f1": det_f1,
        },
    }

    classifier_artifact = {
        "model_type": "logistic_multiclass",
        "feature_order": FEATURE_ORDER,
        "classes": class_names,
        "scaler": cls_scaler.to_json(),
        "weights": cls_w.tolist(),
        "bias": cls_b.tolist(),
        "metrics": {"accuracy": cls_acc},
    }

    ensure_parent(detector_out)
    ensure_parent(classifier_out)
    detector_out.write_text(json.dumps(detector_artifact, indent=2), encoding="utf-8")
    classifier_out.write_text(json.dumps(classifier_artifact, indent=2), encoding="utf-8")
    print(f"[save] detector -> {detector_out}")
    print(f"[save] classifier -> {classifier_out}")


if __name__ == "__main__":
    main()
