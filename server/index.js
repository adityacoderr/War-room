import express from "express";
import cors from "cors";
import { inferFiringFromAudio, inferFiringWithDiagnostics } from "./audioInference.js";

const app = express();
const PORT = 4000;
const KNOWN_GUN_TYPES = new Set(["ak47", "m16", "glock", "pistol", "shotgun", "sniper", "smg", "lmg", "hmg"]);
const BLUETOOTH_RAW_TYPES = ["audio/wav", "audio/x-wav", "application/octet-stream"];
const streamStates = new Map();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

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
    coordinates: { x: 18, y: 24, lat: 28.6139, lng: 77.209 },
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
    coordinates: { x: 44, y: 40, lat: 28.6147, lng: 77.2085 },
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
    coordinates: { x: 67, y: 63, lat: 28.6159, lng: 77.2101 },
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
    map: "Sector-East",
    coordinates: { x: 79, y: 22, lat: 28.6163, lng: 77.2115 },
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
  metrics: getMetrics()
});

const pushLiveUpdate = () => {
  const payload = `data: ${JSON.stringify(getLivePayload())}\n\n`;
  streamClients.forEach((client) => {
    client.write(payload);
  });
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
      "GET /soldiers/raw",
      "GET /soldiers",
      "GET /soldiers/status/:status",
      "GET /soldiers/:id",
      "GET /metrics",
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

  soldier.engaged = Boolean(req.body?.engaged);
  pushLiveUpdate();

  return res.json({ ok: true, id: soldier.id, engaged: soldier.engaged });
});

app.post("/soldiers/:id/fire", (req, res) => {
  const soldier = soldiers.find((s) => s.id === req.params.id.toUpperCase());

  if (!soldier) {
    return res.status(404).json({ error: "Soldier not found" });
  }

  soldier.firing = Boolean(req.body?.firing);
  pushLiveUpdate();

  return res.json({ ok: true, id: soldier.id, firing: soldier.firing });
});

app.post("/audio/detect-firing", (req, res) => {
  try {
    const inference = inferFiringFromAudio(req.body);

    return res.json({
      result: inference.result
    });
  } catch (error) {
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

    return res.json(response);
  } catch (error) {
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

    return res.json(response);
  } catch (error) {
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

    return res.json(response);
  } catch (error) {
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

      return res.json(response);
    } catch (error) {
      return res.status(400).json({
        error: error instanceof Error ? error.message : "Invalid bluetooth threat payload"
      });
    }
  }
);

setInterval(pushLiveUpdate, 1000);
setInterval(cleanupStaleSessions, 30_000);

app.listen(PORT, () => {
  console.log(`War Room API running at http://localhost:${PORT}`);
});
