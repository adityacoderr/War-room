import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TARGET_SAMPLE_RATE = 16000;
const WINDOW_SECONDS = 2;
const WINDOW_SAMPLES = TARGET_SAMPLE_RATE * WINDOW_SECONDS;
const MAX_RAW_INPUT_SAMPLES = TARGET_SAMPLE_RATE * 30;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DETECTOR_MODEL_PATH = path.join(__dirname, "models", "detector.json");
const CLASSIFIER_MODEL_PATH = path.join(__dirname, "models", "classifier.json");

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const FEATURE_ORDER = ["peak", "rms", "crest", "transient", "high_amp_ratio", "centroid"];

let modelCache = {
  detector: null,
  classifier: null,
  detectorMtime: 0,
  classifierMtime: 0
};

const decodeWavToMono = (buffer) => {
  if (buffer.length < 44) {
    throw new Error("Invalid WAV: file too small");
  }

  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Invalid WAV: missing RIFF/WAVE header");
  }

  let offset = 12;
  let fmt = null;
  let dataChunk = null;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;

    if (chunkEnd > buffer.length) {
      break;
    }

    if (chunkId === "fmt ") {
      fmt = {
        audioFormat: buffer.readUInt16LE(chunkStart),
        channels: buffer.readUInt16LE(chunkStart + 2),
        sampleRate: buffer.readUInt32LE(chunkStart + 4),
        bitsPerSample: buffer.readUInt16LE(chunkStart + 14)
      };
    } else if (chunkId === "data") {
      dataChunk = buffer.subarray(chunkStart, chunkEnd);
    }

    offset = chunkEnd + (chunkSize % 2);
  }

  if (!fmt || !dataChunk) {
    throw new Error("Invalid WAV: missing fmt or data chunk");
  }

  if (fmt.audioFormat !== 1 && fmt.audioFormat !== 3) {
    throw new Error("Unsupported WAV format. Use PCM16 or float32");
  }

  const bytesPerSample = fmt.bitsPerSample / 8;
  const frameSize = bytesPerSample * fmt.channels;
  if (!Number.isInteger(frameSize) || frameSize <= 0) {
    throw new Error("Invalid WAV frame size");
  }

  const frameCount = Math.floor(dataChunk.length / frameSize);
  const mono = new Float32Array(frameCount);

  for (let i = 0; i < frameCount; i += 1) {
    let sum = 0;

    for (let ch = 0; ch < fmt.channels; ch += 1) {
      const sampleOffset = i * frameSize + ch * bytesPerSample;
      let sample = 0;

      if (fmt.audioFormat === 1 && fmt.bitsPerSample === 16) {
        sample = dataChunk.readInt16LE(sampleOffset) / 32768;
      } else if (fmt.audioFormat === 3 && fmt.bitsPerSample === 32) {
        sample = dataChunk.readFloatLE(sampleOffset);
      } else {
        throw new Error("Unsupported WAV depth. Use PCM16 or float32");
      }

      sum += clamp(sample, -1, 1);
    }

    mono[i] = sum / fmt.channels;
  }

  return { sampleRate: fmt.sampleRate, samples: mono };
};

const decodePcm16ToMono = (buffer, channels = 1) => {
  if (!Number.isInteger(channels) || channels <= 0) {
    throw new Error("channels must be a positive integer");
  }
  if (buffer.length < 2) {
    throw new Error("PCM16 payload is too small");
  }
  if (buffer.length % 2 !== 0) {
    throw new Error("PCM16 payload must have even byte length");
  }

  const int16 = new Int16Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.length / 2));
  const frameCount = Math.floor(int16.length / channels);
  if (frameCount <= 0) {
    throw new Error("PCM16 payload has no complete frames");
  }

  const mono = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i += 1) {
    let sum = 0;
    for (let ch = 0; ch < channels; ch += 1) {
      const idx = i * channels + ch;
      sum += int16[idx] / 32768;
    }
    mono[i] = clamp(sum / channels, -1, 1);
  }

  return mono;
};

const resampleLinear = (samples, sourceRate, targetRate) => {
  if (sourceRate === targetRate) {
    return samples;
  }

  const newLength = Math.max(1, Math.round(samples.length * (targetRate / sourceRate)));
  const output = new Float32Array(newLength);
  const ratio = sourceRate / targetRate;

  for (let i = 0; i < newLength; i += 1) {
    const sourceIndex = i * ratio;
    const left = Math.floor(sourceIndex);
    const right = Math.min(left + 1, samples.length - 1);
    const t = sourceIndex - left;
    output[i] = samples[left] * (1 - t) + samples[right] * t;
  }

  return output;
};

const toFixedWindow = (samples) => {
  const output = new Float32Array(WINDOW_SAMPLES);
  const usable = Math.min(samples.length, WINDOW_SAMPLES);
  output.set(samples.subarray(0, usable));
  return output;
};

const normalizeAmplitude = (samples) => {
  const output = new Float32Array(samples.length);
  output.set(samples);
  let peak = 0;
  for (let i = 0; i < output.length; i += 1) {
    const value = Math.abs(output[i]);
    if (value > peak) {
      peak = value;
    }
  }

  if (peak > 0) {
    const gain = 1 / peak;
    for (let i = 0; i < output.length; i += 1) {
      output[i] = clamp(output[i] * gain, -1, 1);
    }
  }

  return { normalized: output, peak };
};

const computeRms = (samples) => {
  if (!samples.length) {
    return 0;
  }
  let sumSq = 0;
  for (let i = 0; i < samples.length; i += 1) {
    sumSq += samples[i] * samples[i];
  }
  return Math.sqrt(sumSq / samples.length);
};

const computePeakAbs = (samples) => {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const abs = Math.abs(samples[i]);
    if (abs > peak) {
      peak = abs;
    }
  }
  return peak;
};

const findPeakIndex = (samples) => {
  let peak = 0;
  let peakIndex = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const abs = Math.abs(samples[i]);
    if (abs > peak) {
      peak = abs;
      peakIndex = i;
    }
  }
  return peakIndex;
};

const sliceActiveWindow = (samples, centerIndex, windowSamples) => {
  const half = Math.floor(windowSamples / 2);
  const start = Math.max(0, centerIndex - half);
  const end = Math.min(samples.length, start + windowSamples);
  return samples.subarray(start, end);
};

const readModelIfChanged = (modelPath, lastMtime) => {
  if (!fs.existsSync(modelPath)) {
    return { model: null, mtime: 0 };
  }

  const stats = fs.statSync(modelPath);
  if (stats.mtimeMs <= lastMtime) {
    return { model: undefined, mtime: lastMtime };
  }

  const raw = fs.readFileSync(modelPath, "utf-8");
  return { model: JSON.parse(raw), mtime: stats.mtimeMs };
};

const refreshModelCache = () => {
  const detectorLoaded = readModelIfChanged(DETECTOR_MODEL_PATH, modelCache.detectorMtime);
  if (detectorLoaded.model !== undefined) {
    modelCache.detector = detectorLoaded.model;
    modelCache.detectorMtime = detectorLoaded.mtime;
  }

  const classifierLoaded = readModelIfChanged(CLASSIFIER_MODEL_PATH, modelCache.classifierMtime);
  if (classifierLoaded.model !== undefined) {
    modelCache.classifier = classifierLoaded.model;
    modelCache.classifierMtime = classifierLoaded.mtime;
  }
};

const spectralCentroid = (samples, sampleRate) => {
  const frameSize = 1024;
  const hop = 1024;
  const bins = 64;

  if (samples.length < frameSize) {
    return 0;
  }

  let totalWeighted = 0;
  let totalMagnitude = 0;

  for (let start = 0; start + frameSize <= samples.length; start += hop) {
    for (let bin = 1; bin <= bins; bin += 1) {
      const freq = (bin * sampleRate) / frameSize;
      let re = 0;
      let im = 0;
      const omega = (2 * Math.PI * bin) / frameSize;

      for (let n = 0; n < frameSize; n += 1) {
        const angle = omega * n;
        const value = samples[start + n];
        re += value * Math.cos(angle);
        im -= value * Math.sin(angle);
      }

      const magnitude = Math.sqrt(re * re + im * im);
      totalWeighted += freq * magnitude;
      totalMagnitude += magnitude;
    }
  }

  return totalMagnitude > 0 ? totalWeighted / totalMagnitude : 0;
};

const estimatePitchByZeroCrossing = (samples, sampleRate) => {
  if (samples.length < 2) {
    return 0;
  }
  let crossings = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const prev = samples[i - 1];
    const cur = samples[i];
    if ((prev >= 0 && cur < 0) || (prev < 0 && cur >= 0)) {
      crossings += 1;
    }
  }
  return Number(((crossings * sampleRate) / (2 * samples.length)).toFixed(2));
};

const extractBaseFeatures = (samples) => {
  const peakIndex = findPeakIndex(samples);
  const active = sliceActiveWindow(samples, peakIndex, Math.floor(TARGET_SAMPLE_RATE * 0.25));

  let peak = 0;
  let sumSq = 0;
  let transientSum = 0;
  let highAmpCount = 0;

  for (let i = 0; i < samples.length; i += 1) {
    const abs = Math.abs(samples[i]);
    peak = Math.max(peak, abs);
    sumSq += samples[i] * samples[i];

    if (abs > 0.6) {
      highAmpCount += 1;
    }

    if (i > 0) {
      transientSum += Math.abs(samples[i] - samples[i - 1]);
    }
  }

  const rms = Math.sqrt(sumSq / samples.length);
  const crest = peak / (rms + 1e-6);
  const transient = transientSum / Math.max(1, samples.length - 1);
  const highAmpRatio = highAmpCount / samples.length;
  const activeRms = computeRms(active);
  const activeTransient =
    active.length > 1 ? Number(computeRms(Float32Array.from(active.slice(1).map((v, i) => v - active[i])))) : 0;

  return {
    active,
    peak,
    rms,
    crest,
    transient,
    highAmpRatio,
    activeRms,
    activeTransient
  };
};

const enrichSpectralFeatures = (baseFeatures) => {
  const centroid = spectralCentroid(baseFeatures.active, TARGET_SAMPLE_RATE);
  const activeCentroid = centroid;
  const pitchHz = estimatePitchByZeroCrossing(baseFeatures.active, TARGET_SAMPLE_RATE);
  return {
    ...baseFeatures,
    centroid,
    activeCentroid,
    pitchHz
  };
};

const isLikelySilenceChunk = (baseFeatures) =>
  baseFeatures.rms < 0.01 && baseFeatures.peak < 0.08 && baseFeatures.activeTransient < 0.01;

const getFeatureVector = (features) => [
  features.peak,
  features.rms,
  features.crest,
  features.transient,
  features.highAmpRatio,
  features.centroid
];

const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const sigmoid = (x) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, x))));

const softmax = (arr) => {
  const max = Math.max(...arr);
  const exps = arr.map((v) => Math.exp(v - max));
  const denom = exps.reduce((a, b) => a + b, 0) || 1;
  return exps.map((v) => v / denom);
};

const normalizeFeatureVector = (vector, scaler) => {
  const mean = scaler?.mean ?? [];
  const std = scaler?.std ?? [];

  return vector.map((value, index) => {
    const mu = Number(mean[index] ?? 0);
    const sigma = Number(std[index] ?? 1);
    const safeSigma = Math.abs(sigma) < 1e-6 ? 1 : sigma;
    return (value - mu) / safeSigma;
  });
};

const maybeInferWithModels = (features) => {
  try {
    refreshModelCache();
    if (!modelCache.detector || !modelCache.classifier) {
      return null;
    }

    const featureVector = getFeatureVector(features);
    const detectorOrder = modelCache.detector.feature_order ?? FEATURE_ORDER;
    const classifierOrder = modelCache.classifier.feature_order ?? FEATURE_ORDER;

    if (detectorOrder.join(",") !== FEATURE_ORDER.join(",")) {
      return null;
    }
    if (classifierOrder.join(",") !== FEATURE_ORDER.join(",")) {
      return null;
    }

    const detectorNorm = normalizeFeatureVector(featureVector, modelCache.detector.scaler);
    const detectorWeights = (modelCache.detector.weights ?? []).map(Number);
    const detectorBias = Number(modelCache.detector.bias ?? 0);
    const detectorThreshold = Number(modelCache.detector.threshold ?? 0.5);

    if (!detectorWeights.length) {
      return null;
    }

    const score = sigmoid(dot(detectorNorm, detectorWeights) + detectorBias);
    if (score < detectorThreshold) {
      return {
        result: "no",
        firing: false,
        confidence: Number(score.toFixed(3))
      };
    }

    const classifierNorm = normalizeFeatureVector(featureVector, modelCache.classifier.scaler);
    const classes = Array.isArray(modelCache.classifier.classes) ? modelCache.classifier.classes : [];
    const weightRows = Array.isArray(modelCache.classifier.weights)
      ? modelCache.classifier.weights
      : [];
    const biasVector = Array.isArray(modelCache.classifier.bias) ? modelCache.classifier.bias : [];

    if (!classes.length || !weightRows.length) {
      return null;
    }

    const logits = weightRows.map(
      (row, index) => dot(classifierNorm, row.map(Number)) + Number(biasVector[index] ?? 0)
    );
    const probs = softmax(logits);
    const topIndex = probs.reduce((best, value, i) => (value > probs[best] ? i : best), 0);
    const gunType = String(classes[topIndex] ?? "unknown").toLowerCase();

    return {
      result: `yes(${gunType})`,
      firing: true,
      gunType,
      confidence: Number(score.toFixed(3))
    };
  } catch {
    return null;
  }
};

const detectGunshot = (features) => {
  const score =
    (features.peak > 0.72 ? 0.35 : 0) +
    (features.crest > 4.2 ? 0.25 : 0) +
    (features.transient > 0.03 ? 0.2 : 0) +
    (features.highAmpRatio > 0.0006 && features.highAmpRatio < 0.08 ? 0.1 : 0) +
    (features.centroid > 1200 ? 0.1 : 0);

  return score;
};

const classifyGunType = (features) => {
  if (features.activeTransient > 0.02 && features.activeCentroid > 500) {
    return "pistol";
  }

  if (features.transient < 0.012 && features.centroid < 700 && features.crest > 10) {
    return "shotgun";
  }

  if (features.peak > 0.92 && features.centroid > 1800) {
    return "ak47";
  }
  if (features.crest > 6 && features.centroid > 2000) {
    return "m16";
  }
  if (features.centroid < 1500) {
    return "shotgun";
  }
  if (features.highAmpRatio < 0.002) {
    return "sniper";
  }

  return "pistol";
};

const cleanBase64 = (input) => {
  const trimmed = input.trim();
  const base64Index = trimmed.indexOf("base64,");
  return base64Index >= 0 ? trimmed.slice(base64Index + 7) : trimmed;
};

const normalizeInput = (payload) => {
  if (typeof payload?.audioBase64 === "string") {
    const wavBuffer = Buffer.from(cleanBase64(payload.audioBase64), "base64");
    const decoded = decodeWavToMono(wavBuffer);
    const resampled = resampleLinear(decoded.samples, decoded.sampleRate, TARGET_SAMPLE_RATE);
    const rawWindow = toFixedWindow(resampled);
    const rawPeak = Number(computePeakAbs(rawWindow).toFixed(4));
    const rawRms = Number(computeRms(rawWindow).toFixed(4));
    const normalized = normalizeAmplitude(rawWindow).normalized;
    return { normalized, rawPeak, rawRms };
  }

  if (typeof payload?.pcm16Base64 === "string") {
    const sampleRate = Number(payload.sampleRate) || TARGET_SAMPLE_RATE;
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new Error("sampleRate must be a positive number");
    }
    const channels = Number(payload.channels) || 1;
    const pcmBuffer = Buffer.from(cleanBase64(payload.pcm16Base64), "base64");
    const pcmMono = decodePcm16ToMono(pcmBuffer, channels);
    const resampled = resampleLinear(pcmMono, sampleRate, TARGET_SAMPLE_RATE);
    const rawWindow = toFixedWindow(resampled);
    const rawPeak = Number(computePeakAbs(rawWindow).toFixed(4));
    const rawRms = Number(computeRms(rawWindow).toFixed(4));
    const normalized = normalizeAmplitude(rawWindow).normalized;
    return { normalized, rawPeak, rawRms };
  }

  if (Array.isArray(payload?.samples)) {
    if (!payload.samples.length) {
      throw new Error("samples[] cannot be empty");
    }

    const sourceRate = Number(payload.sampleRate) || TARGET_SAMPLE_RATE;
    if (!Number.isFinite(sourceRate) || sourceRate <= 0) {
      throw new Error("sampleRate must be a positive number");
    }
    const cappedSamples = payload.samples.slice(0, MAX_RAW_INPUT_SAMPLES);
    const mono = Float32Array.from(cappedSamples.map((v) => clamp(Number(v) || 0, -1, 1)));
    const resampled = resampleLinear(mono, sourceRate, TARGET_SAMPLE_RATE);
    const rawWindow = toFixedWindow(resampled);
    const rawPeak = Number(computePeakAbs(rawWindow).toFixed(4));
    const rawRms = Number(computeRms(rawWindow).toFixed(4));
    const normalized = normalizeAmplitude(rawWindow).normalized;
    return { normalized, rawPeak, rawRms };
  }

  throw new Error("Provide audioBase64 (WAV), pcm16Base64, or samples[]");
};

const getProximity = ({ rawPeak, rawRms }) => {
  if (rawRms >= 0.2 || (rawRms >= 0.08 && rawPeak >= 0.9)) {
    return "very_near";
  }
  if (rawRms >= 0.1 || (rawRms >= 0.03 && rawPeak >= 0.65)) {
    return "near";
  }
  if (rawRms >= 0.04 || rawPeak >= 0.35) {
    return "medium";
  }
  return "far";
};

export const inferFiringWithDiagnostics = (payload) => {
  const normalizedInput = normalizeInput(payload);
  const baseFeatures = extractBaseFeatures(normalizedInput.normalized);
  if (isLikelySilenceChunk(baseFeatures)) {
    return {
      result: "no",
      firing: false,
      confidence: 0,
      diagnostics: {
        peak: normalizedInput.rawPeak,
        rms: normalizedInput.rawRms,
        crest: Number(baseFeatures.crest.toFixed(4)),
        transient: Number(baseFeatures.transient.toFixed(4)),
        centroid: 0,
        activeTransient: Number(baseFeatures.activeTransient.toFixed(4)),
        activeCentroid: 0,
        pitchHz: 0,
        proximity: getProximity(normalizedInput),
        chunkState: "early_exit_silence"
      },
      engine: "fast_gate"
    };
  }

  const features = enrichSpectralFeatures(baseFeatures);
  const modelInference = maybeInferWithModels(features);
  const diagnostics = {
    peak: normalizedInput.rawPeak,
    rms: normalizedInput.rawRms,
    crest: Number(features.crest.toFixed(4)),
    transient: Number(features.transient.toFixed(4)),
    centroid: Number(features.centroid.toFixed(2)),
    activeTransient: Number(features.activeTransient.toFixed(4)),
    activeCentroid: Number(features.activeCentroid.toFixed(2)),
    pitchHz: Number(features.pitchHz.toFixed(2)),
    proximity: getProximity(normalizedInput)
  };

  if (modelInference) {
    return {
      ...modelInference,
      diagnostics,
      engine: "trained_model"
    };
  }

  const confidence = detectGunshot(features);

  if (confidence < 0.6) {
    return {
      result: "no",
      firing: false,
      confidence: Number(confidence.toFixed(3)),
      diagnostics,
      engine: "heuristic_fallback"
    };
  }

  const gunType = classifyGunType(features);
  return {
    result: `yes(${gunType})`,
    firing: true,
    gunType,
    confidence: Number(confidence.toFixed(3)),
    diagnostics,
    engine: "heuristic_fallback"
  };
};

export const inferFiringFromAudio = (payload) => {
  const detailed = inferFiringWithDiagnostics(payload);
  return {
    result: detailed.result,
    firing: detailed.firing,
    gunType: detailed.gunType,
    confidence: detailed.confidence
  };
};
