import express from "express";
import { createServer } from "http";
import cors from "cors";
import { WebSocketServer } from "ws";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { inferFiringFromAudio, inferFiringWithDiagnostics } from "./audioInference.js";

const app = express();
const PORT = 4000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const KNOWN_GUN_TYPES = new Set(["ak47", "m16", "glock", "pistol", "shotgun", "sniper", "smg", "lmg", "hmg"]);
const BLUETOOTH_RAW_TYPES = ["audio/wav", "audio/x-wav", "application/octet-stream"];
const streamStates = new Map();
const REPLAY_LOG_DIR = path.join(__dirname, "logs");
const REPLAY_LOG_MAX_BYTES = Number(process.env.REPLAY_LOG_MAX_BYTES ?? 50 * 1024 * 1024);
const REPLAY_DEFAULT_LIMIT = 500;
const OPERATION_REPLAY_WRITE_ENABLED = String(process.env.OPERATION_REPLAY_WRITE_ENABLED ?? "false") === "true";

let replaySequence = 0;
let replayLogFilePath = "";

app.use(cors());
app.use(express.json({ limit: "10mb" }));

const ensureReplayLogFile = () => {
  fs.mkdirSync(REPLAY_LOG_DIR, { recursive: true });
  if (replayLogFilePath && fs.existsSync(replayLogFilePath)) {
    return replayLogFilePath;
  }
  const datePart = new Date().toISOString().slice(0, 10);
  replayLogFilePath = path.join(REPLAY_LOG_DIR, `operation-replay-${datePart}.jsonl`);
  return replayLogFilePath;
};

const rotateReplayLogIfNeeded = () => {
  const filePath = ensureReplayLogFile();
  if (!fs.existsSync(filePath)) {
    return filePath;
  }
  const size = fs.statSync(filePath).size;
  if (size < REPLAY_LOG_MAX_BYTES) {
    return filePath;
  }

  const stamp = new Date().toISOString().replaceAll(":", "-");
  const rotated = filePath.replace(".jsonl", `-${stamp}.jsonl`);
  fs.renameSync(filePath, rotated);
  replayLogFilePath = "";
  return ensureReplayLogFile();
};

const summarizePayloadForReplay = (value) => {
  if (value == null) return value;
  if (typeof value !== "object") return value;

  if (Array.isArray(value)) {
    if (value.length > 100) {
      return {
        omitted: true,
        reason: "array_too_large",
        count: value.length
      };
    }
    return value.map((item) => summarizePayloadForReplay(item));
  }

  const summary = {};
  for (const [key, raw] of Object.entries(value)) {
    if (key === "audioBase64" || key === "pcm16Base64") {
      summary[key] = {
        omitted: true,
        reason: "binary_audio",
        length: typeof raw === "string" ? raw.length : 0
      };
      continue;
    }

    if (key === "samples" && Array.isArray(raw)) {
      summary[key] = {
        omitted: true,
        reason: "sample_array",
        count: raw.length
      };
      continue;
    }

    if (Buffer.isBuffer(raw)) {
      summary[key] = {
        omitted: true,
        reason: "buffer",
        bytes: raw.length
      };
      continue;
    }

    summary[key] = summarizePayloadForReplay(raw);
  }

  return summary;
};

const appendReplayEvent = (type, details = {}) => {
  if (!OPERATION_REPLAY_WRITE_ENABLED) {
    return;
  }
  try {
    const filePath = rotateReplayLogIfNeeded();
    const now = new Date();
    const event = {
      seq: ++replaySequence,
      timestamp: now.toISOString(),
      ts: now.getTime(),
      type,
      details: summarizePayloadForReplay(details)
    };
    fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, "utf-8");
  } catch (error) {
    console.error("[replay-log] failed to append event:", error instanceof Error ? error.message : error);
  }
};

const listReplayLogFiles = () => {
  fs.mkdirSync(REPLAY_LOG_DIR, { recursive: true });
  return fs
    .readdirSync(REPLAY_LOG_DIR)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => {
      const filePath = path.join(REPLAY_LOG_DIR, name);
      const stat = fs.statSync(filePath);
      return {
        file: name,
        bytes: stat.size,
        updatedAt: stat.mtime.toISOString()
      };
    })
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
};

const loadReplayEvents = ({ file, type, limit }) => {
  const selectedFile = file
    ? path.basename(file)
    : path.basename(ensureReplayLogFile());
  const filePath = path.join(REPLAY_LOG_DIR, selectedFile);
  if (!fs.existsSync(filePath)) {
    return { file: selectedFile, count: 0, events: [] };
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  const lines = raw.split("\n").filter(Boolean);
  const parsed = lines
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const filtered = type ? parsed.filter((event) => String(event.type) === String(type)) : parsed;
  const cap = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(10_000, Number(limit))) : REPLAY_DEFAULT_LIMIT;
  return {
    file: selectedFile,
    count: filtered.length,
    events: filtered.slice(-cap)
  };
};

const isHttpUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

const postResultToWatch = async ({ callbackUrl, watchId, result }) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(callbackUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        watchId,
        result,
        timestamp: new Date().toISOString()
      }),
      signal: controller.signal
    });

    return {
      ok: response.ok,
      status: response.status
    };
  } finally {
    clearTimeout(timeoutId);
  }
};

const postResultToWatchSafe = async ({ callbackUrl, watchId, result }) => {
  try {
    return await postResultToWatch({ callbackUrl, watchId, result });
  } catch (error) {
    return {
      ok: false,
      status: null,
      error: error instanceof Error ? error.message : "callback delivery failed"
    };
  }
};

const readHeader = (headers, key) => {
  const value = headers[key];
  if (Array.isArray(value)) {
    return value[0];
  }
  return typeof value === "string" ? value : undefined;
};

const getSessionState = (sessionId) => {
  const existing = streamStates.get(sessionId);
  if (existing) {
    return existing;
  }
  const created = {
    history: [],
    lastSeenAt: Date.now()
  };
  streamStates.set(sessionId, created);
  return created;
};

const appendChunkAndAggregate = ({ sessionId, inference }) => {
  const state = getSessionState(sessionId);
  state.lastSeenAt = Date.now();
  state.history.push({
    ts: state.lastSeenAt,
    firing: Boolean(inference.firing),
    gunType: inference.gunType ?? null,
    confidence: Number(inference.confidence ?? 0)
  });

  if (state.history.length > 6) {
    state.history.splice(0, state.history.length - 6);
  }

  const recent = state.history.slice(-3);
  if (recent.length < 2) {
    const last = recent[recent.length - 1];
    if (!last || !last.firing) {
      return {
        result: "no",
        firing: false,
        confidence: Number((last?.confidence ?? 0).toFixed(3)),
        window: recent.length
      };
    }
    return {
      result: `yes(${last.gunType ?? "unknown"})`,
      firing: true,
      gunType: last.gunType ?? "unknown",
      confidence: Number((last.confidence ?? 0).toFixed(3)),
      window: recent.length
    };
  }

  const firingVotes = recent.filter((item) => item.firing).length;
  const firing = firingVotes >= 2;
  if (!firing) {
    return {
      result: "no",
      firing: false,
      confidence: Number(
        (recent.reduce((sum, item) => sum + item.confidence, 0) / Math.max(1, recent.length)).toFixed(3)
      ),
      window: recent.length
    };
  }

  const gunVote = new Map();
  for (const item of recent) {
    if (!item.firing || !item.gunType) {
      continue;
    }
    gunVote.set(item.gunType, (gunVote.get(item.gunType) ?? 0) + 1);
  }
  const gunType =
    [...gunVote.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ??
    recent.filter((item) => item.gunType).slice(-1)[0]?.gunType ??
    "unknown";

  return {
    result: `yes(${gunType})`,
    firing: true,
    gunType,
    confidence: Number(Math.max(...recent.map((item) => item.confidence)).toFixed(3)),
    window: recent.length
  };
};

const cleanupStaleSessions = () => {
  const now = Date.now();
  for (const [sessionId, state] of streamStates.entries()) {
    if (now - state.lastSeenAt > 60_000) {
      streamStates.delete(sessionId);
    }
  }
};

const buildBluetoothInferencePayload = (req) => {
  if (Buffer.isBuffer(req.body) && req.body.length > 0) {
    const declaredFormat = (readHeader(req.headers, "x-audio-format") || "wav").toLowerCase();
    if (declaredFormat === "pcm16") {
      return {
        pcm16Base64: req.body.toString("base64"),
        sampleRate: Number(readHeader(req.headers, "x-sample-rate")) || 16000,
        channels: Number(readHeader(req.headers, "x-channels")) || 1
      };
    }

    return {
      audioBase64: req.body.toString("base64")
    };
  }

  if (req.body && typeof req.body === "object") {
    return req.body;
  }

  throw new Error("Provide bluetooth audio as raw bytes or JSON body");
};

const normalizeGunName = (name) => {
  if (typeof name !== "string" || name.trim().length === 0) {
    return null;
  }

  const cleaned = name.toLowerCase().replace(/[\s_-]/g, "");
  const aliases = {
    ak47: "ak47",
    ak: "ak47",
    m16: "m16",
    m4: "m16",
    glock: "glock",
    pistol: "pistol",
    shotgun: "shotgun",
    sniper: "sniper",
    sinper: "sniper",
    sniperrifle: "sniper",
    smg: "smg",
    lmg: "lmg",
    hmg: "hmg"
  };

  return aliases[cleaned] ?? cleaned;
};

const extractGunFromResult = (result) => {
  if (typeof result !== "string") {
    return null;
  }
  const match = result.match(/^yes\((.+)\)$/i);
  return match ? normalizeGunName(match[1]) : null;
};

const buildThreatAssessment = ({ soldierGunName, inference }) => {
  const soldierGun = normalizeGunName(soldierGunName);
  const detectedGun = normalizeGunName(inference.gunType ?? extractGunFromResult(inference.result));
  const proximity = inference.diagnostics?.proximity ?? "unknown";

  if (!inference.firing) {
    return {
      threat: "no_firing_detected",
      source: "none",
      reason: "No gunshot detected in the audio window."
    };
  }

  if (!soldierGun) {
    return {
      threat: "firing_detected",
      source: "uncertain",
      reason: "Soldier gun name not provided, cannot compare against detected gun."
    };
  }

  if (!KNOWN_GUN_TYPES.has(soldierGun)) {
    return {
      threat: "firing_detected",
      source: "uncertain",
      reason: `Soldier gun ${soldierGun} is not in known gun types; cannot compare reliably.`
    };
  }

  if (!detectedGun) {
    return {
      threat: "firing_detected",
      source: "uncertain",
      reason: "Gunshot detected but gun type classification was unavailable."
    };
  }

  if (!KNOWN_GUN_TYPES.has(detectedGun)) {
    return {
      threat: "firing_detected",
      source: "uncertain",
      reason: `Detected gun ${detectedGun} is outside known gun types; source cannot be confirmed.`
    };
  }

  if (soldierGun !== detectedGun) {
    return {
      threat: "confirmed_enemy_fire",
      source: "enemy",
      reason: `Detected gun ${detectedGun} differs from soldier gun ${soldierGun}.`
    };
  }

  if (proximity === "very_near" || proximity === "near") {
    return {
      threat: "likely_friendly_fire",
      source: "friendly_likely",
      reason: `Same gun type (${detectedGun}) and high local intensity (${proximity}) suggest nearby own/friendly fire.`
    };
  }

  if (proximity === "far") {
    return {
      threat: "possible_enemy_same_weapon",
      source: "enemy_possible",
      reason: `Same gun type (${detectedGun}) with low local intensity (${proximity}) suggests possible distant enemy/friendly fire.`
    };
  }

  return {
    threat: "same_weapon_uncertain_source",
    source: "uncertain",
    reason: `Same gun type (${detectedGun}) detected; source cannot be confirmed from single audio window.`
  };
};

const soldiers = [
  {
    id: "ALPHA-01",
    name: "Unit A1",
    altitude: 14,
    spo2: 95,
    bloodOxygenLevel: 95,
    bloodPressure: { systolic: 118, diastolic: 76 },
    mapValue: 90,
    map: "Sector-North",
    coordinates: { x: 48, y: 51, lat: 28.6142, lng: 77.2092 },
    floor: 0,
    lifeStatus: "alive",
    healthStatus: "healthy",
    engaged: true,
    firing: false,
    tampered: false
  },
  {
    id: "ALPHA-02",
    name: "Unit A2",
    altitude: 31,
    spo2: 91,
    bloodOxygenLevel: 90,
    bloodPressure: { systolic: 122, diastolic: 82 },
    mapValue: 95,
    map: "Sector-North",
    coordinates: { x: 53, y: 54, lat: 28.61455, lng: 77.20945 },
    floor: 2,
    lifeStatus: "alive",
    healthStatus: "injured",
    engaged: true,
    firing: true,
    tampered: false
  },
  {
    id: "BRAVO-03",
    name: "Unit B3",
    altitude: 12,
    spo2: 0,
    bloodOxygenLevel: 0,
    bloodPressure: { systolic: 0, diastolic: 0 },
    mapValue: 0,
    map: "Sector-East",
    coordinates: { x: 46, y: 58, lat: 28.61475, lng: 77.209 },
    floor: 0,
    lifeStatus: "dead",
    healthStatus: "dead",
    engaged: false,
    firing: false,
    tampered: false
  },
  {
    id: "CHARLIE-04",
    name: "Unit C4",
    altitude: 46,
    spo2: 95,
    bloodOxygenLevel: 94,
    bloodPressure: { systolic: 128, diastolic: 84 },
    mapValue: 98,
    map: "Sector-South",
    coordinates: { x: 84, y: 86, lat: 28.6178, lng: 77.2122 },
    floor: 4,
    lifeStatus: "alive",
    healthStatus: "healthy",
    engaged: false,
    firing: false,
    tampered: true
  }
];

const validStatuses = new Set(["alive", "injured", "dead", "healthy", "tampered"]);
const streamClients = new Set();
const wsClients = new Set();
const WS_OPEN_STATE = 1;
const squadMotionState = new Map();
const wsDirectionState = new Map();
const SQUAD_SPLIT_THRESHOLD_METERS = 180;
const ISOLATION_THRESHOLD_METERS = 80;
const AMBUSH_PREV_SPEED_THRESHOLD_MPS = 1.2;
const AMBUSH_STOP_SPEED_THRESHOLD_MPS = 0.35;
const COORDINATED_MIN_SPEED_MPS = 0.5;
const COORDINATED_PARALLEL_SCORE_THRESHOLD = 0.82;

const toRad = (value) => (value * Math.PI) / 180;

const distanceMeters = (a, b) => {
  if (!a || !b) return 0;
  const earthRadius = 6_371_000;
  const lat1 = toRad(Number(a.lat) || 0);
  const lat2 = toRad(Number(b.lat) || 0);
  const dLat = lat2 - lat1;
  const dLng = toRad((Number(b.lng) || 0) - (Number(a.lng) || 0));
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return 2 * earthRadius * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
};

const dot2 = (a, b) => (a.x * b.x) + (a.y * b.y);

const norm2 = (v) => Math.sqrt((v.x * v.x) + (v.y * v.y));

const normalizeVector = (v) => {
  const magnitude = norm2(v);
  if (magnitude <= 0) return { x: 0, y: 0 };
  return { x: v.x / magnitude, y: v.y / magnitude };
};

const describeActivity = (soldier) => {
  if (soldier.lifeStatus === "dead") return "down";
  if (soldier.firing) return "firing";
  if (soldier.engaged) return "engaged";
  return "moving";
};

const pairwiseMaxDistance = (units) => {
  let maxDistance = 0;
  for (let i = 0; i < units.length; i += 1) {
    for (let j = i + 1; j < units.length; j += 1) {
      maxDistance = Math.max(maxDistance, distanceMeters(units[i].coordinates, units[j].coordinates));
    }
  }
  return maxDistance;
};

const computeNearestDistances = (units) => {
  return units.map((unit, index) => {
    let nearestDistanceMeters = Infinity;
    let nearestSoldierId = null;

    for (let i = 0; i < units.length; i += 1) {
      if (i === index) continue;
      const distance = distanceMeters(unit.coordinates, units[i].coordinates);
      if (distance < nearestDistanceMeters) {
        nearestDistanceMeters = distance;
        nearestSoldierId = units[i].id;
      }
    }

    return {
      id: unit.id,
      nearestSoldierId,
      nearestDistanceMeters: Number((Number.isFinite(nearestDistanceMeters) ? nearestDistanceMeters : 0).toFixed(2))
    };
  });
};

const toDegrees = (radians) => (radians * 180) / Math.PI;

const normalizeAngle = (angle) => {
  if (!Number.isFinite(angle)) return 0;
  const normalized = angle % 360;
  return normalized < 0 ? normalized + 360 : normalized;
};

const derivePacketActivity = (soldier, speedMps = 0) => {
  if (soldier.lifeStatus === "dead") return "down";
  if (soldier.firing) return "firing";
  if (speedMps >= 1.5) return "running";
  if (speedMps >= 0.3) return "moving";
  if (soldier.engaged) return "engaged";
  return "idle";
};

const computeDirectionAngle = (soldier) => {
  const previous = wsDirectionState.get(soldier.id);
  const current = {
    x: Number(soldier.coordinates?.x) || 0,
    y: Number(soldier.coordinates?.y) || 0,
    tsMs: Date.now()
  };

  let gunfireDir = previous?.gunfireDir ?? 0;
  let speedMps = previous?.speedMps ?? 0;

  if (previous) {
    const deltaTimeSec = Math.max(0.001, (current.tsMs - previous.tsMs) / 1000);
    const dx = current.x - previous.x;
    const dy = current.y - previous.y;
    const distance = Math.hypot(dx, dy);
    speedMps = distance / deltaTimeSec;
    if (distance > 0.001) {
      gunfireDir = normalizeAngle(toDegrees(Math.atan2(dy, dx)));
    }
  }

  wsDirectionState.set(soldier.id, {
    ...current,
    gunfireDir,
    speedMps
  });

  return { gunfireDir: Number(gunfireDir.toFixed(2)), speedMps: Number(speedMps.toFixed(2)) };
};

const buildSoldierPacket = (soldier) => {
  const { gunfireDir, speedMps } = computeDirectionAngle(soldier);
  return {
    soldier_id: soldier.id,
    position: {
      x: Number(soldier.coordinates?.x) || 0,
      y: Number(soldier.coordinates?.y) || 0
    },
    latlng: {
      lat: Number(soldier.coordinates?.lat) || 0,
      lng: Number(soldier.coordinates?.lng) || 0
    },
    origin_place: soldier.map ?? "Unknown",
    activity: derivePacketActivity(soldier, speedMps),
    health: soldier.healthStatus ?? "unknown",
    gunfire_dir: gunfireDir,
    timestamp: Date.now()
  };
};

const broadcastWsPacket = (packet) => {
  const data = JSON.stringify(packet);
  for (const client of wsClients) {
    if (client.readyState === WS_OPEN_STATE) {
      client.send(data);
    }
  }
};

const broadcastSoldierPackets = () => {
  if (wsClients.size === 0) return;
  soldiers.forEach((soldier) => {
    broadcastWsPacket(buildSoldierPacket(soldier));
  });
};

const computeSquadIntelligence = () => {
  const timestamp = new Date().toISOString();
  const nowMs = Date.now();
  const aliveUnits = soldiers.filter((unit) => unit.lifeStatus === "alive");
  const movements = [];
  let suddenStops = 0;

  for (const unit of aliveUnits) {
    const previous = squadMotionState.get(unit.id);
    const previousPosition = previous?.position;
    const previousTsMs = previous?.tsMs ?? nowMs;
    const deltaTimeSec = Math.max(0.001, (nowMs - previousTsMs) / 1000);
    const meters = previousPosition ? distanceMeters(previousPosition, unit.coordinates) : 0;
    const speedMps = meters / deltaTimeSec;
    const vector = previousPosition
      ? {
          x: (Number(unit.coordinates.lng) || 0) - (Number(previousPosition.lng) || 0),
          y: (Number(unit.coordinates.lat) || 0) - (Number(previousPosition.lat) || 0)
        }
      : { x: 0, y: 0 };

    if (
      previous &&
      Number(previous.speedMps ?? 0) >= AMBUSH_PREV_SPEED_THRESHOLD_MPS &&
      speedMps <= AMBUSH_STOP_SPEED_THRESHOLD_MPS
    ) {
      suddenStops += 1;
    }

    squadMotionState.set(unit.id, {
      tsMs: nowMs,
      position: unit.coordinates,
      speedMps
    });

    movements.push({
      id: unit.id,
      activity: describeActivity(unit),
      heartRate: null,
      speedMps: Number(speedMps.toFixed(2)),
      vector
    });
  }

  for (const id of squadMotionState.keys()) {
    if (!aliveUnits.some((unit) => unit.id === id)) {
      squadMotionState.delete(id);
    }
  }

  const movingVectors = movements
    .filter((item) => item.speedMps >= COORDINATED_MIN_SPEED_MPS)
    .map((item) => normalizeVector(item.vector));

  let parallelScore = 0;
  let comparisons = 0;
  for (let i = 0; i < movingVectors.length; i += 1) {
    for (let j = i + 1; j < movingVectors.length; j += 1) {
      parallelScore += dot2(movingVectors[i], movingVectors[j]);
      comparisons += 1;
    }
  }
  const averageParallelScore = comparisons > 0 ? parallelScore / comparisons : 0;
  const coordinatedDetected =
    movingVectors.length >= 2 && averageParallelScore >= COORDINATED_PARALLEL_SCORE_THRESHOLD;

  const gunfireDetected = aliveUnits.some((unit) => unit.firing);
  const ambushDetected = gunfireDetected && suddenStops >= 2;
  const maxDistanceMeters = pairwiseMaxDistance(aliveUnits);
  const squadSplitDetected = aliveUnits.length >= 2 && maxDistanceMeters > SQUAD_SPLIT_THRESHOLD_METERS;
  const nearestDistances = computeNearestDistances(aliveUnits);
  const isolatedSoldiers = nearestDistances.filter(
    (item) => aliveUnits.length > 1 && item.nearestDistanceMeters > ISOLATION_THRESHOLD_METERS
  );
  const isolationDetected = isolatedSoldiers.length > 0;

  const averageSpeedMps =
    movements.length > 0
      ? Number((movements.reduce((sum, movement) => sum + movement.speedMps, 0) / movements.length).toFixed(2))
      : 0;

  const alerts = [];
  if (ambushDetected) {
    alerts.push({
      type: "possible_ambush",
      title: "Possible Ambush",
      severity: "critical",
      message: "Gunfire detected and multiple soldiers stopped suddenly."
    });
  }

  if (squadSplitDetected) {
    alerts.push({
      type: "squad_dispersed",
      title: "Squad Dispersed",
      severity: "warning",
      message: `Distance spread exceeded threshold (${Math.round(maxDistanceMeters)}m > ${SQUAD_SPLIT_THRESHOLD_METERS}m).`
    });
  }

  if (coordinatedDetected) {
    alerts.push({
      type: "coordinated_movement",
      title: "Coordinated Movement",
      severity: "info",
      message: "Parallel movement vectors indicate formation movement."
    });
  }

  for (const isolated of isolatedSoldiers) {
    alerts.push({
      type: "soldier_isolated",
      title: "Soldier Isolated",
      severity: "warning",
      message: `${isolated.id} isolated. Distance: ${Math.round(isolated.nearestDistanceMeters)}m`
    });
  }

  return {
    timestamp,
    algorithm: "rule_based+statistical",
    inputData: {
      positions: aliveUnits.length,
      activities: movements.map((item) => ({ id: item.id, activity: item.activity })),
      heartRate: movements.map((item) => ({ id: item.id, bpm: item.heartRate })),
      gunfire: gunfireDetected,
      movementSpeed: movements.map((item) => ({ id: item.id, mps: item.speedMps }))
    },
    patterns: {
      ambushDetection: {
        detected: ambushDetected,
        gunfireDetected,
        suddenStops
      },
      squadSplit: {
        detected: squadSplitDetected,
        thresholdMeters: SQUAD_SPLIT_THRESHOLD_METERS,
        maxDistanceMeters: Number(maxDistanceMeters.toFixed(2))
      },
      coordinatedMovement: {
        detected: coordinatedDetected,
        movingSoldiers: movingVectors.length,
        parallelScore: Number(averageParallelScore.toFixed(3)),
        threshold: COORDINATED_PARALLEL_SCORE_THRESHOLD
      },
      soldierIsolation: {
        detected: isolationDetected,
        thresholdMeters: ISOLATION_THRESHOLD_METERS,
        isolatedCount: isolatedSoldiers.length,
        isolatedSoldiers
      }
    },
    stats: {
      aliveUnits: aliveUnits.length,
      avgSpeedMps: averageSpeedMps
    },
    alerts
  };
};

const getMetrics = () => {
  const total = soldiers.length;
  const alive = soldiers.filter((s) => s.lifeStatus === "alive").length;
  const injured = soldiers.filter((s) => s.healthStatus === "injured").length;
  const dead = soldiers.filter((s) => s.lifeStatus === "dead").length;
  const healthy = soldiers.filter((s) => s.healthStatus === "healthy").length;
  const tampered = soldiers.filter((s) => s.tampered).length;

  const avgAltitude = Number((soldiers.reduce((a, s) => a + s.altitude, 0) / total).toFixed(2));
  const avgSpo2 = Number((soldiers.reduce((a, s) => a + s.spo2, 0) / total).toFixed(2));
  const avgBloodOxygen = Number(
    (soldiers.reduce((a, s) => a + s.bloodOxygenLevel, 0) / total).toFixed(2)
  );

  return {
    total,
    alive,
    injured,
    dead,
    healthy,
    tampered,
    avgAltitude,
    avgSpo2,
    avgBloodOxygen
  };
};

const getLivePayload = () => ({
  timestamp: new Date().toISOString(),
  soldiers,
  metrics: getMetrics(),
  squadIntelligence: computeSquadIntelligence()
});

const pushLiveUpdate = () => {
  const livePayload = getLivePayload();
  const payload = `data: ${JSON.stringify(livePayload)}\n\n`;
  streamClients.forEach((client) => {
    client.write(payload);
  });
  appendReplayEvent("live_state_snapshot", {
    soldiers: livePayload.soldiers,
    metrics: livePayload.metrics,
    squadIntelligence: livePayload.squadIntelligence,
    streamClients: streamClients.size
  });
  broadcastSoldierPackets();
};

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "war-room-api",
    timestamp: new Date().toISOString(),
    metrics: getMetrics()
  });
});

app.get("/routes", (_req, res) => {
  res.json({
    routes: [
      "GET /health",
      "GET /routes",
      "GET /stream",
      "WS  /ws",
      "GET /operation-replay/log-files",
      "GET /operation-replay/logs",
      "GET /replay/log-files (alias)",
      "GET /replay/logs (alias)",
      "GET /soldiers/raw",
      "GET /soldiers",
      "GET /soldiers/status/:status",
      "GET /soldiers/:id",
      "GET /metrics",
      "GET /intelligence/squad",
      "POST /soldiers/:id/engage",
      "POST /soldiers/:id/fire",
      "POST /audio/detect-firing",
      "POST /watch/audio-event",
      "POST /watch/threat-assessment",
      "POST /bluetooth/audio-event",
      "POST /bluetooth/threat-assessment"
    ]
  });
});

app.get("/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  streamClients.add(res);
  res.write(`data: ${JSON.stringify(getLivePayload())}\n\n`);

  req.on("close", () => {
    streamClients.delete(res);
  });
});

app.get("/metrics", (_req, res) => {
  res.json(getMetrics());
});

const getOperationReplayLogFiles = (_req, res) => {
  return res.json({
    feature: "Operation Replay",
    directory: REPLAY_LOG_DIR,
    files: listReplayLogFiles()
  });
};

app.get("/operation-replay/log-files", getOperationReplayLogFiles);
app.get("/replay/log-files", getOperationReplayLogFiles);

const getOperationReplayLogs = (req, res) => {
  const { file = "", type = "", limit = REPLAY_DEFAULT_LIMIT } = req.query;
  return res.json({
    feature: "Operation Replay",
    ...loadReplayEvents({ file, type, limit })
  });
};

app.get("/operation-replay/logs", getOperationReplayLogs);
app.get("/replay/logs", getOperationReplayLogs);

app.get("/intelligence/squad", (_req, res) => {
  res.json(computeSquadIntelligence());
});

app.get("/soldiers/raw", (_req, res) => {
  res.json({
    count: soldiers.length,
    data: soldiers
  });
});

app.get("/soldiers", (_req, res) => {
  res.json(soldiers);
});

app.get("/soldiers/status/:status", (req, res) => {
  const status = req.params.status.toLowerCase();

  if (!validStatuses.has(status)) {
    return res.status(400).json({
      error: `Invalid status. Use one of: ${Array.from(validStatuses).join(", ")}`
    });
  }

  const filtered = soldiers.filter((soldier) => {
    if (status === "alive") {
      return soldier.lifeStatus === "alive";
    }

    if (status === "dead") {
      return soldier.lifeStatus === "dead";
    }

    if (status === "tampered") {
      return soldier.tampered;
    }

    return soldier.healthStatus === status;
  });

  return res.json({ count: filtered.length, data: filtered });
});

app.get("/soldiers/:id", (req, res) => {
  const soldier = soldiers.find((s) => s.id === req.params.id.toUpperCase());

  if (!soldier) {
    return res.status(404).json({ error: "Soldier not found" });
  }

  return res.json(soldier);
});

app.post("/soldiers/:id/engage", (req, res) => {
  const soldier = soldiers.find((s) => s.id === req.params.id.toUpperCase());

  if (!soldier) {
    return res.status(404).json({ error: "Soldier not found" });
  }

  const previousEngaged = soldier.engaged;
  soldier.engaged = Boolean(req.body?.engaged);
  appendReplayEvent("soldier_engage_update", {
    id: soldier.id,
    previous: { engaged: previousEngaged },
    next: { engaged: soldier.engaged },
    request: req.body,
    source: {
      ip: req.ip,
      userAgent: req.headers["user-agent"] ?? null
    }
  });
  pushLiveUpdate();

  return res.json({ ok: true, id: soldier.id, engaged: soldier.engaged });
});

app.post("/soldiers/:id/fire", (req, res) => {
  const soldier = soldiers.find((s) => s.id === req.params.id.toUpperCase());

  if (!soldier) {
    return res.status(404).json({ error: "Soldier not found" });
  }

  const previousFiring = soldier.firing;
  soldier.firing = Boolean(req.body?.firing);
  appendReplayEvent("soldier_fire_update", {
    id: soldier.id,
    previous: { firing: previousFiring },
    next: { firing: soldier.firing },
    request: req.body,
    source: {
      ip: req.ip,
      userAgent: req.headers["user-agent"] ?? null
    }
  });
  pushLiveUpdate();

  return res.json({ ok: true, id: soldier.id, firing: soldier.firing });
});

app.post("/audio/detect-firing", (req, res) => {
  try {
    const inference = inferFiringFromAudio(req.body);
    appendReplayEvent("audio_detect_firing", {
      request: req.body,
      result: inference.result
    });

    return res.json({
      result: inference.result
    });
  } catch (error) {
    appendReplayEvent("audio_detect_firing_error", {
      request: req.body,
      error: error instanceof Error ? error.message : "Invalid audio payload"
    });
    return res.status(400).json({
      error: error instanceof Error ? error.message : "Invalid audio payload"
    });
  }
});

app.post("/watch/audio-event", async (req, res) => {
  try {
    const { watchId = "unknown-watch", callbackUrl } = req.body ?? {};
    const inference = inferFiringFromAudio(req.body);
    const result = inference.result;

    const response = {
      watchId,
      result
    };

    if (typeof callbackUrl === "string" && callbackUrl.trim().length > 0) {
      if (!isHttpUrl(callbackUrl)) {
        return res.status(400).json({ error: "callbackUrl must be a valid http/https URL" });
      }

      const callbackDelivery = await postResultToWatchSafe({ callbackUrl, watchId, result });
      response.callback = callbackDelivery;
    }

    appendReplayEvent("watch_audio_event", {
      watchId,
      request: req.body,
      result
    });

    return res.json(response);
  } catch (error) {
    appendReplayEvent("watch_audio_event_error", {
      request: req.body,
      error: error instanceof Error ? error.message : "Invalid watch audio payload"
    });
    return res.status(400).json({
      error: error instanceof Error ? error.message : "Invalid watch audio payload"
    });
  }
});

app.post("/watch/threat-assessment", async (req, res) => {
  try {
    const { watchId = "unknown-watch", callbackUrl, soldierGunName } = req.body ?? {};
    const inference = inferFiringWithDiagnostics(req.body);
    const assessment = buildThreatAssessment({ soldierGunName, inference });

    const response = {
      watchId,
      soldierGunName: soldierGunName ?? null,
      result: inference.result,
      assessment,
      diagnostics: inference.diagnostics
    };

    if (typeof callbackUrl === "string" && callbackUrl.trim().length > 0) {
      if (!isHttpUrl(callbackUrl)) {
        return res.status(400).json({ error: "callbackUrl must be a valid http/https URL" });
      }

      const callbackDelivery = await postResultToWatchSafe({
        callbackUrl,
        watchId,
        result: inference.result
      });
      response.callback = callbackDelivery;
    }

    appendReplayEvent("watch_threat_assessment", {
      watchId,
      soldierGunName: soldierGunName ?? null,
      request: req.body,
      result: inference.result,
      assessment
    });

    return res.json(response);
  } catch (error) {
    appendReplayEvent("watch_threat_assessment_error", {
      request: req.body,
      error: error instanceof Error ? error.message : "Invalid watch threat payload"
    });
    return res.status(400).json({
      error: error instanceof Error ? error.message : "Invalid watch threat payload"
    });
  }
});

app.post("/bluetooth/audio-event", express.raw({ type: BLUETOOTH_RAW_TYPES, limit: "10mb" }), async (req, res) => {
  try {
    const payload = buildBluetoothInferencePayload(req);
    const watchId = payload.watchId ?? readHeader(req.headers, "x-watch-id") ?? "unknown-watch";
    const sessionId =
      payload.sessionId ?? readHeader(req.headers, "x-session-id") ?? readHeader(req.headers, "x-stream-id") ?? watchId;
    const callbackUrl = payload.callbackUrl ?? readHeader(req.headers, "x-callback-url");
    const inference = inferFiringFromAudio(payload);
    const aggregated = appendChunkAndAggregate({ sessionId, inference });

    const response = {
      watchId,
      result: aggregated.result,
      aggregated,
      chunk: inference,
      sessionId,
      source: "bluetooth"
    };

    if (typeof callbackUrl === "string" && callbackUrl.trim().length > 0) {
      if (!isHttpUrl(callbackUrl)) {
        return res.status(400).json({ error: "callbackUrl must be a valid http/https URL" });
      }
      response.callback = await postResultToWatchSafe({
        callbackUrl,
        watchId,
        result: inference.result
      });
    }

    appendReplayEvent("bluetooth_audio_event", {
      watchId,
      sessionId,
      payload,
      aggregated,
      chunk: inference.result
    });

    return res.json(response);
  } catch (error) {
    appendReplayEvent("bluetooth_audio_event_error", {
      headers: req.headers,
      bodyBytes: Buffer.isBuffer(req.body) ? req.body.length : 0,
      error: error instanceof Error ? error.message : "Invalid bluetooth audio payload"
    });
    return res.status(400).json({
      error: error instanceof Error ? error.message : "Invalid bluetooth audio payload"
    });
  }
});

app.post(
  "/bluetooth/threat-assessment",
  express.raw({ type: BLUETOOTH_RAW_TYPES, limit: "10mb" }),
  async (req, res) => {
    try {
      const payload = buildBluetoothInferencePayload(req);
      const watchId = payload.watchId ?? readHeader(req.headers, "x-watch-id") ?? "unknown-watch";
      const sessionId =
        payload.sessionId ??
        readHeader(req.headers, "x-session-id") ??
        readHeader(req.headers, "x-stream-id") ??
        watchId;
      const callbackUrl = payload.callbackUrl ?? readHeader(req.headers, "x-callback-url");
      const soldierGunName =
        payload.soldierGunName ??
        readHeader(req.headers, "x-soldier-gun-name") ??
        readHeader(req.headers, "x-soldier-gun");
      const inference = inferFiringWithDiagnostics(payload);
      const aggregated = appendChunkAndAggregate({ sessionId, inference });
      const assessment = buildThreatAssessment({
        soldierGunName,
        inference: {
          ...inference,
          result: aggregated.result,
          firing: aggregated.firing,
          gunType: aggregated.gunType,
          confidence: aggregated.confidence
        }
      });

      const response = {
        watchId,
        sessionId,
        soldierGunName: soldierGunName ?? null,
        result: aggregated.result,
        aggregated,
        chunk: {
          result: inference.result,
          firing: inference.firing,
          gunType: inference.gunType,
          confidence: inference.confidence
        },
        assessment,
        diagnostics: inference.diagnostics,
        source: "bluetooth"
      };

      if (typeof callbackUrl === "string" && callbackUrl.trim().length > 0) {
        if (!isHttpUrl(callbackUrl)) {
          return res.status(400).json({ error: "callbackUrl must be a valid http/https URL" });
        }
        response.callback = await postResultToWatchSafe({
          callbackUrl,
          watchId,
          result: inference.result
        });
      }

      appendReplayEvent("bluetooth_threat_assessment", {
        watchId,
        sessionId,
        soldierGunName: soldierGunName ?? null,
        payload,
        result: aggregated.result,
        assessment
      });

      return res.json(response);
    } catch (error) {
      appendReplayEvent("bluetooth_threat_assessment_error", {
        headers: req.headers,
        bodyBytes: Buffer.isBuffer(req.body) ? req.body.length : 0,
        error: error instanceof Error ? error.message : "Invalid bluetooth threat payload"
      });
      return res.status(400).json({
        error: error instanceof Error ? error.message : "Invalid bluetooth threat payload"
      });
    }
  }
);

setInterval(pushLiveUpdate, 1000);
setInterval(cleanupStaleSessions, 30_000);

const server = createServer(app);
const wsServer = new WebSocketServer({ noServer: true });

wsServer.on("connection", (socket) => {
  wsClients.add(socket);
  appendReplayEvent("ws_client_connected", { clients: wsClients.size });
  soldiers.forEach((soldier) => {
    socket.send(JSON.stringify(buildSoldierPacket(soldier)));
  });

  socket.on("close", () => {
    wsClients.delete(socket);
    appendReplayEvent("ws_client_disconnected", { clients: wsClients.size });
  });
});

server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/ws") {
    socket.destroy();
    return;
  }

  wsServer.handleUpgrade(req, socket, head, (client) => {
    wsServer.emit("connection", client, req);
  });
});

server.listen(PORT, () => {
  console.log(`War Room API running at http://localhost:${PORT}`);
  console.log(`War Room WebSocket stream at ws://localhost:${PORT}/ws`);
  console.log(
    `Operation Replay writes: ${OPERATION_REPLAY_WRITE_ENABLED ? "enabled" : "disabled"} (set OPERATION_REPLAY_WRITE_ENABLED=true to enable)`
  );
  appendReplayEvent("system_start", {
    port: PORT,
    operationReplayLogFile: path.basename(ensureReplayLogFile())
  });
});
