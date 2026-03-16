import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import { MapContainer, Marker, TileLayer, Tooltip, useMap } from "react-leaflet";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:4000";
const POLL_INTERVAL_MS = 2000;
const STALE_AFTER_MS = 8000;
const THRESHOLD_STORAGE_KEY = "war-room-alert-thresholds-v1";
const DEFAULT_ALERT_THRESHOLDS = {
  spo2: { min: 90, max: 100 },
  systolic: { min: 90, max: 140 },
  diastolic: { min: 60, max: 90 },
  mapValue: { min: 65, max: 105 }
};

const clampNumber = (value, min, max, fallback = 0) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
};

const normalizeSoldier = (raw, index) => {
  const id = String(raw?.id || `UNIT-${index + 1}`);
  const lifeStatus = raw?.lifeStatus === "dead" ? "dead" : "alive";
  const healthStatus = ["healthy", "injured", "dead"].includes(raw?.healthStatus)
    ? raw.healthStatus
    : "healthy";

  return {
    id,
    name: String(raw?.name || id),
    altitude: clampNumber(raw?.altitude, -500, 12000, 0),
    spo2: clampNumber(raw?.spo2, 0, 100, 0),
    bloodOxygenLevel: clampNumber(raw?.bloodOxygenLevel, 0, 100, 0),
    bloodPressure: {
      systolic: clampNumber(raw?.bloodPressure?.systolic, 0, 260, 0),
      diastolic: clampNumber(raw?.bloodPressure?.diastolic, 0, 180, 0)
    },
    mapValue: clampNumber(raw?.mapValue, 0, 180, 0),
    map: String(raw?.map || "Unknown"),
    coordinates: {
      x: clampNumber(raw?.coordinates?.x, 0, 100, 0),
      y: clampNumber(raw?.coordinates?.y, 0, 100, 0),
      lat: clampNumber(raw?.coordinates?.lat, -90, 90, 0),
      lng: clampNumber(raw?.coordinates?.lng, -180, 180, 0)
    },
    floor: Math.max(0, Math.trunc(clampNumber(raw?.floor, 0, 200, 0))),
    lifeStatus,
    healthStatus,
    engaged: Boolean(raw?.engaged),
    firing: Boolean(raw?.firing),
    tampered: Boolean(raw?.tampered)
  };
};

const normalizeSoldiers = (list) => {
  if (!Array.isArray(list)) return [];
  return list.map((soldier, index) => normalizeSoldier(soldier, index));
};

const computeFleetBounds = (soldiers) => {
  if (!soldiers.length) return null;

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;

  soldiers.forEach((soldier) => {
    minLat = Math.min(minLat, soldier.coordinates.lat);
    maxLat = Math.max(maxLat, soldier.coordinates.lat);
    minLng = Math.min(minLng, soldier.coordinates.lng);
    maxLng = Math.max(maxLng, soldier.coordinates.lng);
  });

  return { minLat, maxLat, minLng, maxLng };
};

const hasMeaningfulBoundsShift = (previous, next) => {
  if (!previous || !next) return true;
  const threshold = 0.00012;
  return (
    Math.abs(previous.minLat - next.minLat) > threshold ||
    Math.abs(previous.maxLat - next.maxLat) > threshold ||
    Math.abs(previous.minLng - next.minLng) > threshold ||
    Math.abs(previous.maxLng - next.maxLng) > threshold
  );
};

const statusColorClass = (soldier) => {
  if (soldier.tampered) return "status-red";
  if (soldier.lifeStatus === "dead") return "status-white";
  if (soldier.healthStatus === "injured") return "status-yellow";
  if (soldier.healthStatus === "healthy") return "status-green";
  return "status-green";
};

const markerIcon = (soldier, selected) => {
  const colorClass = statusColorClass(soldier);
  const shapeClass = soldier.floor === 0 ? "shape-dot" : "shape-triangle";
  const isInjured = soldier.healthStatus === "injured" && soldier.lifeStatus !== "dead";
  const showFloorBadge = soldier.floor > 0;

  return L.divIcon({
    className: "soldier-icon-wrap",
    html: `
      <div class="soldier-icon">
        <div class="marker-shell ${selected ? "marker-shell-selected" : ""}">
          <div class="marker ${shapeClass} ${colorClass} ${selected ? "marker-selected" : ""}"></div>
          ${showFloorBadge ? `<span class="marker-badge badge-floor">F${soldier.floor}</span>` : ""}
          ${isInjured ? `<span class="marker-badge badge-injured">INJ</span>` : ""}
        </div>
      </div>
    `,
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });
};

const MapActionButtons = ({ soldiers, selectedSoldier }) => {
  const map = useMap();
  const zoomTimerRef = useRef(null);
  const lastFocusedSoldierRef = useRef("");
  const lastAutoFitBoundsRef = useRef(null);

  useEffect(() => {
    const stopZoomLoop = () => {
      if (zoomTimerRef.current) {
        window.clearInterval(zoomTimerRef.current);
        zoomTimerRef.current = null;
      }
    };

    const startZoomLoop = (direction) => {
      if (zoomTimerRef.current) return;

      const run = () => {
        const currentZoom = map.getZoom();
        const maxZoom = map.getMaxZoom();
        const minZoom = map.getMinZoom();

        if (direction > 0) {
          if (currentZoom >= maxZoom) {
            stopZoomLoop();
            return;
          }
          map.zoomIn();
        } else {
          if (currentZoom <= minZoom) {
            stopZoomLoop();
            return;
          }
          map.zoomOut();
        }
      };

      run();
      zoomTimerRef.current = window.setInterval(run, 110);
    };

    const onKeyDown = (event) => {
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        startZoomLoop(1);
      }

      if (event.key === "-") {
        event.preventDefault();
        startZoomLoop(-1);
      }
    };

    const onKeyUp = (event) => {
      if (event.key === "+" || event.key === "=" || event.key === "-") {
        stopZoomLoop();
      }
    };

    const onBlur = () => stopZoomLoop();

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);

    return () => {
      stopZoomLoop();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [map]);

  const fitAll = () => {
    if (!soldiers.length) return;
    const bounds = L.latLngBounds(
      soldiers.map((soldier) => [soldier.coordinates.lat, soldier.coordinates.lng])
    );
    map.fitBounds(bounds, { padding: [40, 40] });
    lastAutoFitBoundsRef.current = computeFleetBounds(soldiers);
  };

  const focusSelected = () => {
    if (!selectedSoldier) return;
    map.flyTo([selectedSoldier.coordinates.lat, selectedSoldier.coordinates.lng], 18, {
      duration: 0.7
    });
  };

  useEffect(() => {
    if (!selectedSoldier) return;
    if (lastFocusedSoldierRef.current === selectedSoldier.id) return;

    const targetZoom = Math.max(map.getZoom(), 18);
    map.flyTo([selectedSoldier.coordinates.lat, selectedSoldier.coordinates.lng], targetZoom, {
      duration: 0.7
    });
    lastFocusedSoldierRef.current = selectedSoldier.id;
  }, [map, selectedSoldier]);

  useEffect(() => {
    if (!soldiers.length || selectedSoldier) return;

    const currentBounds = computeFleetBounds(soldiers);
    const shouldRefit = hasMeaningfulBoundsShift(lastAutoFitBoundsRef.current, currentBounds);

    if (shouldRefit) {
      const bounds = L.latLngBounds(
        soldiers.map((soldier) => [soldier.coordinates.lat, soldier.coordinates.lng])
      );
      map.fitBounds(bounds, { padding: [40, 40] });
      lastAutoFitBoundsRef.current = currentBounds;
    }

    lastFocusedSoldierRef.current = "";
  }, [map, soldiers, selectedSoldier]);

  return (
    <div className="map-controls">
      <button type="button" onClick={fitAll}>Fit All</button>
      <button type="button" onClick={focusSelected} disabled={!selectedSoldier}>Focus Selected</button>
      <div className="map-shortcuts">Shortcuts: `+` zoom in, `-` zoom out</div>
    </div>
  );
};

const outOfRangeReason = (label, value, range) => {
  if (range.min != null && value < range.min) {
    return `${label} ${value} < ${range.min}`;
  }
  if (range.max != null && value > range.max) {
    return `${label} ${value} > ${range.max}`;
  }
  return "";
};

export default function App() {
  const [soldiers, setSoldiers] = useState([]);
  const [metrics, setMetrics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedSoldierId, setSelectedSoldierId] = useState("");
  const [lastRefreshAt, setLastRefreshAt] = useState("");
  const [alarmEnabled, setAlarmEnabled] = useState(true);
  const [audioArmed, setAudioArmed] = useState(false);
  const [liveUpdateCount, setLiveUpdateCount] = useState(0);
  const [streamStatus, setStreamStatus] = useState("connecting");
  const [isStale, setIsStale] = useState(false);
  const [alertThresholds, setAlertThresholds] = useState(DEFAULT_ALERT_THRESHOLDS);
  const [isThresholdModalOpen, setIsThresholdModalOpen] = useState(false);
  const audioContextRef = useRef(null);
  const alarmIntervalRef = useRef(null);
  const latestSnapshotRef = useRef("");

  useEffect(() => {
    try {
      const persisted = localStorage.getItem(THRESHOLD_STORAGE_KEY);
      if (!persisted) return;
      const parsed = JSON.parse(persisted);
      setAlertThresholds({
        spo2: {
          min: clampNumber(parsed?.spo2?.min, 0, 100, DEFAULT_ALERT_THRESHOLDS.spo2.min),
          max: clampNumber(parsed?.spo2?.max, 0, 100, DEFAULT_ALERT_THRESHOLDS.spo2.max)
        },
        systolic: {
          min: clampNumber(parsed?.systolic?.min, 0, 260, DEFAULT_ALERT_THRESHOLDS.systolic.min),
          max: clampNumber(parsed?.systolic?.max, 0, 260, DEFAULT_ALERT_THRESHOLDS.systolic.max)
        },
        diastolic: {
          min: clampNumber(parsed?.diastolic?.min, 0, 180, DEFAULT_ALERT_THRESHOLDS.diastolic.min),
          max: clampNumber(parsed?.diastolic?.max, 0, 180, DEFAULT_ALERT_THRESHOLDS.diastolic.max)
        },
        mapValue: {
          min: clampNumber(parsed?.mapValue?.min, 0, 180, DEFAULT_ALERT_THRESHOLDS.mapValue.min),
          max: clampNumber(parsed?.mapValue?.max, 0, 180, DEFAULT_ALERT_THRESHOLDS.mapValue.max)
        }
      });
    } catch (_error) {
      // ignore malformed local data
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(THRESHOLD_STORAGE_KEY, JSON.stringify(alertThresholds));
  }, [alertThresholds]);

  const applyIncomingData = useCallback((incomingSoldiersRaw, metricJson, timestamp = "") => {
    const incomingSoldiers = normalizeSoldiers(incomingSoldiersRaw);

    const nextSnapshot = JSON.stringify({
      incomingSoldiers,
      metricJson
    });

    if (nextSnapshot !== latestSnapshotRef.current) {
      latestSnapshotRef.current = nextSnapshot;
      setSoldiers(incomingSoldiers);
      setMetrics(metricJson);
      setLastRefreshAt(timestamp || new Date().toISOString());
      setLiveUpdateCount((prev) => prev + 1);
      setSelectedSoldierId((prev) =>
        incomingSoldiers.some((soldier) => soldier.id === prev) ? prev : ""
      );
    }
  }, []);

  useEffect(() => {
    let active = true;

    const fetchJson = async (url) => {
      const response = await fetch(url, { cache: "no-store" });
      return response.json();
    };

    const load = async () => {
      try {
        const [soldierJson, metricJson] = await Promise.all([
          fetchJson(`${API_BASE}/soldiers/raw`),
          fetchJson(`${API_BASE}/metrics`)
        ]);

        if (!active) return;

        applyIncomingData(soldierJson.data || [], metricJson);
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    load();

    const onVisible = () => {
      if (document.visibilityState === "visible") {
        load();
      }
    };

    const interval = setInterval(load, POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [applyIncomingData]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") {
      setStreamStatus("unsupported");
      return;
    }

    let source;
    let retryTimer;
    let retryCount = 0;
    let closed = false;

    const connect = () => {
      if (closed) return;

      setStreamStatus(retryCount === 0 ? "connecting" : "reconnecting");
      source = new EventSource(`${API_BASE}/stream`);

      source.onopen = () => {
        retryCount = 0;
        setStreamStatus("connected");
      };

      source.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          applyIncomingData(payload.soldiers || [], payload.metrics || null, payload.timestamp || "");
          setLoading(false);
        } catch (_error) {
          // Ignore malformed stream packet.
        }
      };

      source.onerror = () => {
        if (source) {
          source.close();
        }
        setStreamStatus("disconnected");
        const delay = Math.min(10000, 1000 * 2 ** retryCount);
        retryCount += 1;
        retryTimer = window.setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      closed = true;
      if (source) source.close();
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [applyIncomingData]);

  useEffect(() => {
    const checkStale = () => {
      if (!lastRefreshAt) {
        setIsStale(true);
        return;
      }

      const ageMs = Date.now() - new Date(lastRefreshAt).getTime();
      setIsStale(ageMs > STALE_AFTER_MS);
    };

    checkStale();
    const interval = window.setInterval(checkStale, 1000);
    return () => window.clearInterval(interval);
  }, [lastRefreshAt]);

  const soldierCount = soldiers.length;

  const dataHealth = useMemo(() => {
    if (!metrics) {
      return [];
    }

    return [
      ["No. of Soldiers", metrics.total],
      ["Alive", metrics.alive],
      ["Injured", metrics.injured],
      ["Dead", metrics.dead],
      ["Healthy", metrics.healthy],
      ["Tampered", metrics.tampered],
      ["Avg Altitude", metrics.avgAltitude],
      ["Avg SpO2", metrics.avgSpo2],
      ["Avg Blood Oxygen", metrics.avgBloodOxygen]
    ];
  }, [metrics]);

  const selectedSoldier = useMemo(
    () => soldiers.find((soldier) => soldier.id === selectedSoldierId) || null,
    [soldiers, selectedSoldierId]
  );

  const updateThreshold = (metric, bound, value) => {
    setAlertThresholds((prev) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        return prev;
      }

      const nextMetric = { ...prev[metric], [bound]: parsed };
      if (nextMetric.min > nextMetric.max) {
        if (bound === "min") {
          nextMetric.max = parsed;
        } else {
          nextMetric.min = parsed;
        }
      }

      return {
        ...prev,
        [metric]: nextMetric
      };
    });
  };

  const resetThresholds = () => {
    setAlertThresholds(DEFAULT_ALERT_THRESHOLDS);
  };

  useEffect(() => {
    if (!isThresholdModalOpen) return;

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        setIsThresholdModalOpen(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isThresholdModalOpen]);

  const alarmViolations = useMemo(() => {
    return soldiers
      .filter((soldier) => soldier.lifeStatus !== "dead")
      .map((soldier) => {
        const reasons = [
          outOfRangeReason("SpO2", soldier.spo2, alertThresholds.spo2),
          outOfRangeReason("Systolic", soldier.bloodPressure.systolic, alertThresholds.systolic),
          outOfRangeReason("Diastolic", soldier.bloodPressure.diastolic, alertThresholds.diastolic),
          outOfRangeReason("MAP", soldier.mapValue, alertThresholds.mapValue)
        ].filter(Boolean);

        return { id: soldier.id, reasons };
      })
      .filter((item) => item.reasons.length > 0);
  }, [soldiers, alertThresholds]);

  const alarmActive = alarmEnabled && alarmViolations.length > 0;

  const armAudioContext = async () => {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return false;

      if (!audioContextRef.current) {
        audioContextRef.current = new AudioCtx();
      }

      if (audioContextRef.current.state === "suspended") {
        await audioContextRef.current.resume();
      }

      const running = audioContextRef.current.state === "running";
      setAudioArmed(running);
      return running;
    } catch (_error) {
      setAudioArmed(false);
      return false;
    }
  };

  const playAlarmBeep = () => {
    try {
      const ctx = audioContextRef.current;
      if (!ctx || ctx.state !== "running") {
        return false;
      }

      const now = ctx.currentTime;
      const makePulse = (startAt, frequency) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = "sine";
        osc.frequency.setValueAtTime(frequency, startAt);
        osc.frequency.exponentialRampToValueAtTime(frequency * 1.08, startAt + 0.08);

        gain.gain.setValueAtTime(0.0001, startAt);
        gain.gain.exponentialRampToValueAtTime(0.18, startAt + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.2);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(startAt);
        osc.stop(startAt + 0.22);
      };

      makePulse(now, 760);
      makePulse(now + 0.26, 980);
      return true;
    } catch (_error) {
      return false;
    }
  };

  useEffect(() => {
    const unlockAudio = () => {
      armAudioContext();
    };

    window.addEventListener("pointerdown", unlockAudio);
    window.addEventListener("keydown", unlockAudio);

    return () => {
      window.removeEventListener("pointerdown", unlockAudio);
      window.removeEventListener("keydown", unlockAudio);
    };
  }, []);

  useEffect(() => {
    const stopAlarmLoop = () => {
      if (alarmIntervalRef.current) {
        window.clearInterval(alarmIntervalRef.current);
        alarmIntervalRef.current = null;
      }
    };

    if (alarmActive && audioArmed) {
      playAlarmBeep();
      alarmIntervalRef.current = window.setInterval(playAlarmBeep, 950);
    } else {
      stopAlarmLoop();
    }

    return () => stopAlarmLoop();
  }, [alarmActive, audioArmed]);

  const onAlarmButtonClick = async () => {
    if (!audioArmed) {
      const ready = await armAudioContext();
      if (ready) {
        playAlarmBeep();
        setAlarmEnabled(true);
      }
      return;
    }

    setAlarmEnabled((prev) => !prev);
  };

  const formattedLastSync = useMemo(() => {
    if (!lastRefreshAt) return "Pending";
    const date = new Date(lastRefreshAt);
    if (Number.isNaN(date.getTime())) return lastRefreshAt;

    return new Intl.DateTimeFormat("en-IN", {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(date);
  }, [lastRefreshAt]);

  const mapCenter = useMemo(() => {
    if (!soldiers.length) return [28.6139, 77.209];

    const aggregate = soldiers.reduce(
      (acc, soldier) => {
        return {
          lat: acc.lat + soldier.coordinates.lat,
          lng: acc.lng + soldier.coordinates.lng
        };
      },
      { lat: 0, lng: 0 }
    );

    return [aggregate.lat / soldiers.length, aggregate.lng / soldiers.length];
  }, [soldiers]);

  return (
    <main className="page">
      <header className="topbar">
        <h1>War Room Tactical Dashboard</h1>
        <p>Raw telemetry feed with floor-aware map markers and combat state.</p>
        <small className="sync-text">Latest feed sync: {formattedLastSync}</small>
        <small className="sync-text sync-text-secondary">
          Live feed: {streamStatus.toUpperCase()} | Poll fallback: {POLL_INTERVAL_MS / 1000}s | Changes applied: {liveUpdateCount}
        </small>
      </header>

      {isStale ? (
        <section className="alarm-banner alarm-stale">
          <div>
            <strong>DATA STALE</strong>
            <span>No new telemetry for more than {STALE_AFTER_MS / 1000}s. Check watch uplink/network.</span>
          </div>
        </section>
      ) : null}

      <section className={`alarm-banner ${alarmActive ? "alarm-live" : "alarm-idle"}`}>
        <div>
          <strong>{alarmActive ? "WARNING" : "Monitoring Stable"}</strong>
          <span>
            Thresholds: SpO2 {alertThresholds.spo2.min}-{alertThresholds.spo2.max}, BP {alertThresholds.systolic.min}-{alertThresholds.systolic.max}/{alertThresholds.diastolic.min}-{alertThresholds.diastolic.max}, MAP {alertThresholds.mapValue.min}-{alertThresholds.mapValue.max} | Audio: {audioArmed ? "ready" : "not enabled"}
          </span>
        </div>
        <button type="button" onClick={onAlarmButtonClick}>
          {!audioArmed ? "Enable Alarm Audio" : alarmEnabled ? "Mute Alarm" : "Unmute Alarm"}
        </button>
      </section>

      <section className="threshold-cta">
        <button type="button" onClick={() => setIsThresholdModalOpen(true)}>Set Alarm Threshold</button>
      </section>

      {isThresholdModalOpen ? (
        <div className="threshold-modal-backdrop" onClick={() => setIsThresholdModalOpen(false)}>
          <section className="panel threshold-panel threshold-modal" onClick={(event) => event.stopPropagation()}>
            <div className="threshold-head">
              <h2>Alarm Threshold Settings</h2>
              <div className="threshold-head-actions">
                <button type="button" onClick={resetThresholds}>Reset Defaults</button>
                <button type="button" onClick={() => setIsThresholdModalOpen(false)}>Close</button>
              </div>
            </div>
            <div className="threshold-grid">
              <label>
                <span>SpO2 Min</span>
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={alertThresholds.spo2.min}
                  onChange={(event) => updateThreshold("spo2", "min", event.target.value)}
                />
              </label>
              <label>
                <span>SpO2 Max</span>
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={alertThresholds.spo2.max}
                  onChange={(event) => updateThreshold("spo2", "max", event.target.value)}
                />
              </label>
              <label>
                <span>Systolic Min</span>
                <input
                  type="number"
                  min="0"
                  max="260"
                  value={alertThresholds.systolic.min}
                  onChange={(event) => updateThreshold("systolic", "min", event.target.value)}
                />
              </label>
              <label>
                <span>Systolic Max</span>
                <input
                  type="number"
                  min="0"
                  max="260"
                  value={alertThresholds.systolic.max}
                  onChange={(event) => updateThreshold("systolic", "max", event.target.value)}
                />
              </label>
              <label>
                <span>Diastolic Min</span>
                <input
                  type="number"
                  min="0"
                  max="180"
                  value={alertThresholds.diastolic.min}
                  onChange={(event) => updateThreshold("diastolic", "min", event.target.value)}
                />
              </label>
              <label>
                <span>Diastolic Max</span>
                <input
                  type="number"
                  min="0"
                  max="180"
                  value={alertThresholds.diastolic.max}
                  onChange={(event) => updateThreshold("diastolic", "max", event.target.value)}
                />
              </label>
              <label>
                <span>MAP Min</span>
                <input
                  type="number"
                  min="0"
                  max="180"
                  value={alertThresholds.mapValue.min}
                  onChange={(event) => updateThreshold("mapValue", "min", event.target.value)}
                />
              </label>
              <label>
                <span>MAP Max</span>
                <input
                  type="number"
                  min="0"
                  max="180"
                  value={alertThresholds.mapValue.max}
                  onChange={(event) => updateThreshold("mapValue", "max", event.target.value)}
                />
              </label>
            </div>
          </section>
        </div>
      ) : null}

      {alarmViolations.length > 0 ? (
        <section className="alarm-details">
          {alarmViolations.map((violation) => (
            <div key={violation.id} className="alarm-item">
              <strong>{violation.id}</strong>: {violation.reasons.join(" | ")}
            </div>
          ))}
        </section>
      ) : null}

      {loading ? <div className="loading">Loading data...</div> : null}

      <section className="grid">
        <article className="panel wide map-panel">
          <h2>Map View</h2>
          <div className="map-box osm-map-box">
            <MapContainer
              center={mapCenter}
              zoom={17}
              scrollWheelZoom
              className="osm-map"
            >
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              <MapActionButtons soldiers={soldiers} selectedSoldier={selectedSoldier} />

              {soldiers.map((soldier) => (
                <Marker
                  key={soldier.id}
                  position={[soldier.coordinates.lat, soldier.coordinates.lng]}
                  icon={markerIcon(soldier, soldier.id === selectedSoldierId)}
                  eventHandlers={{
                    click: () => setSelectedSoldierId(soldier.id)
                  }}
                >
                  <Tooltip direction="top" offset={[0, -10]} opacity={0.9}>
                    {soldier.id} | F{soldier.floor}
                  </Tooltip>
                </Marker>
              ))}
            </MapContainer>
          </div>
          <div className="legend">
            <span><i className="dot-icon" />Floor 0 = Dot</span>
            <span><i className="triangle-icon" />Floor &gt; 0 = Triangle</span>
            <span><i className="legend-color status-yellow" />Injured</span>
            <span><i className="legend-color status-white" />Dead</span>
            <span><i className="legend-color status-green" />Healthy</span>
            <span><i className="legend-color status-red" />Tampered</span>
          </div>
        </article>

        <article className="panel latest-panel">
          <h2>Latest Soldier Update</h2>
          {selectedSoldier ? (
            <div className="detail-grid">
              <div className="detail-row"><span>ID</span><strong>{selectedSoldier.id}</strong></div>
              <div className="detail-row"><span>Map</span><strong>{selectedSoldier.map}</strong></div>
              <div className="detail-row"><span>Coordinates</span><strong>{selectedSoldier.coordinates.lat}, {selectedSoldier.coordinates.lng}</strong></div>
              <div className="detail-row"><span>Altitude</span><strong>{selectedSoldier.altitude}</strong></div>
              <div className="detail-row"><span>SpO2</span><strong>{selectedSoldier.spo2}</strong></div>
              <div className="detail-row"><span>Blood Oxygen</span><strong>{selectedSoldier.bloodOxygenLevel}</strong></div>
              <div className="detail-row"><span>BP</span><strong>{selectedSoldier.bloodPressure.systolic}/{selectedSoldier.bloodPressure.diastolic}</strong></div>
              <div className="detail-row"><span>MAP</span><strong>{selectedSoldier.mapValue}</strong></div>
              <div className="detail-row"><span>Floor</span><strong>{selectedSoldier.floor}</strong></div>
              <div className="detail-row"><span>Life</span><strong>{selectedSoldier.lifeStatus}</strong></div>
              <div className="detail-row"><span>Health</span><strong>{selectedSoldier.healthStatus}</strong></div>
              <div className="detail-row"><span>Tampered</span><strong>{selectedSoldier.tampered ? "YES" : "NO"}</strong></div>
              <div className="detail-row"><span>Engage</span><strong>{selectedSoldier.engaged ? "YES" : "NO"}</strong></div>
              <div className="detail-row"><span>Fire</span><strong>{selectedSoldier.firing ? "YES" : "NO"}</strong></div>
            </div>
          ) : (
            <p>Select a soldier marker on map to view latest updates.</p>
          )}
        </article>

        <article className="panel">
          <h2>Telemetry Summary</h2>
          <div className="stats">
            {dataHealth.map(([label, value]) => (
              <div key={label} className="stat">
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
        </article>

        <article className="panel wide">
          <h2>Soldier Raw Data ({soldierCount})</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Altitude</th>
                  <th>SpO2</th>
                  <th>Blood O2</th>
                  <th>BP</th>
                  <th>MAP</th>
                  <th>Map</th>
                  <th>Coordinates</th>
                  <th>Floor</th>
                  <th>Status</th>
                  <th>Engage</th>
                  <th>Fire</th>
                </tr>
              </thead>
              <tbody>
                {soldiers.map((soldier) => (
                  <tr
                    key={soldier.id}
                    className={soldier.id === selectedSoldierId ? "row-selected" : ""}
                    onClick={() => setSelectedSoldierId(soldier.id)}
                  >
                    <td>{soldier.id}</td>
                    <td>{soldier.altitude}</td>
                    <td>{soldier.spo2}</td>
                    <td>{soldier.bloodOxygenLevel}</td>
                    <td>{soldier.bloodPressure.systolic}/{soldier.bloodPressure.diastolic}</td>
                    <td>{soldier.mapValue}</td>
                    <td>{soldier.map}</td>
                    <td>{soldier.coordinates.lat}, {soldier.coordinates.lng}</td>
                    <td>{soldier.floor}</td>
                    <td>
                      <span className={`pill ${statusColorClass(soldier)}`}>
                        {soldier.tampered
                          ? "tampered"
                          : soldier.lifeStatus === "dead"
                            ? "dead"
                            : soldier.healthStatus}
                      </span>
                    </td>
                    <td>{soldier.engaged ? "YES" : "NO"}</td>
                    <td>{soldier.firing ? "YES" : "NO"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>
      </section>
    </main>
  );
}
