import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import { Circle, MapContainer, Marker, Polygon, Polyline, TileLayer, Tooltip, useMap } from "react-leaflet";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:4000";
const EXTERNAL_WATCH_ENDPOINT = `${API_BASE}/external-watch/live`;
const KEYWORD_ALERTS_ENDPOINT = `${API_BASE}/watch/keyword-alerts/latest`;
const KEYWORD_ALERT_POST_ENDPOINT = `${API_BASE}/watch/keyword-alert`;
const DEFAULT_EXTERNAL_WATCH_URL = import.meta.env.VITE_EXTERNAL_WATCH_URL || "http://192.168.137.135/";
const THRESHOLD_STORAGE_KEY = "war-room-alert-thresholds-v1";
const SYNC_MODE_STORAGE_KEY = "war-room-sync-mode-v1";
const DEFAULT_SYNC_MODE = "normal";
const SYNC_MODES = {
  normal: {
    label: "Normal",
    description: "Data sync every 5 seconds",
    pollIntervalMs: 5_000,
    staleAfterMs: 45_000,
    useLiveStream: false
  },
  combat: {
    label: "Combat",
    description: "Data sync every 2 seconds",
    pollIntervalMs: 2_000,
    staleAfterMs: 12_000,
    useLiveStream: false
  },
  emergency: {
    label: "Emergency",
    description: "Live stream mode (SSE)",
    pollIntervalMs: 1_000,
    staleAfterMs: 8_000,
    useLiveStream: true
  }
};
const DEFAULT_ALERT_THRESHOLDS = {
  systolic: { min: 90, max: 140 },
  diastolic: { min: 60, max: 90 },
  mapValue: { min: 65, max: 105 }
};
const WATCH_ALERT_KEYWORDS = ["ENEMY", "HELP", "FALLBACK", "AMBUSH"];

const clampNumber = (value, min, max, fallback = 0) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
};

const normalizeHealthCode = (value) => {
  if (value === 0 || value === "0") return { lifeStatus: "alive", healthStatus: "healthy" };
  if (value === 1 || value === "1") return { lifeStatus: "alive", healthStatus: "injured" };
  if (value === 2 || value === "2") return { lifeStatus: "dead", healthStatus: "dead" };
  return null;
};

const detectKeywordFromTranscript = (value) => {
  const text = String(value || "").toUpperCase();
  if (!text) return null;
  return WATCH_ALERT_KEYWORDS.find((keyword) => new RegExp(`\\b${keyword}\\b`, "i").test(text)) || null;
};

const normalizeSource = (raw) => ({
  placeholderPosition: Boolean(raw?.placeholderPosition),
  rssi: Number.isFinite(Number(raw?.rssi)) ? Number(raw.rssi) : null,
  distanceMeters: Number.isFinite(Number(raw?.distanceMeters)) ? Number(raw.distanceMeters) : null,
  heartRate: Number.isFinite(Number(raw?.heartRate)) ? Number(raw.heartRate) : null,
  healthCode: Number.isFinite(Number(raw?.healthCode)) ? Number(raw.healthCode) : null,
  hasGpsFix: Boolean(raw?.hasGpsFix),
  blockType: String(raw?.blockType || ""),
  stream: String(raw?.stream || "")
});

const normalizeSoldier = (raw, index) => {
  const id = String(raw?.id || `UNIT-${index + 1}`);
  const directHealth = normalizeHealthCode(raw?.healthStatus ?? raw?.source?.healthCode);
  const lifeStatus = directHealth?.lifeStatus || (raw?.lifeStatus === "dead" ? "dead" : "alive");
  const healthStatus = directHealth?.healthStatus || (
    ["healthy", "injured", "dead"].includes(raw?.healthStatus)
      ? raw.healthStatus
      : "healthy"
  );

  return {
    id,
    name: String(raw?.name || id),
    altitude: clampNumber(raw?.altitude, -500, 12000, 0),
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
    activity: String(raw?.activity || "unknown").toLowerCase(),
    activityConfidence: clampNumber(raw?.activityConfidence, 0, 1, 0),
    imu: {
      headingDeg: Number.isFinite(Number(raw?.imu?.headingDeg)) ? Number(raw.imu.headingDeg) : null,
      stepRateSpm: Number.isFinite(Number(raw?.imu?.stepRateSpm)) ? Number(raw.imu.stepRateSpm) : null,
      updatedAt: String(raw?.imu?.updatedAt || "")
    },
    engaged: Boolean(raw?.engaged),
    firing: Boolean(raw?.firing),
    tampered: Boolean(raw?.tampered),
    source: normalizeSource(raw?.source)
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

const directionArrowIcon = ({ bearingDeg, active }) =>
  L.divIcon({
    className: "direction-arrow-wrap",
    html: `
      <div class="direction-arrow ${active ? "direction-arrow-active" : ""}" style="transform: rotate(${bearingDeg}deg)">
        ▲
      </div>
    `,
    iconSize: [20, 20],
    iconAnchor: [10, 10]
  });

const getDummyBearing = (id) => {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = ((hash << 5) - hash) + id.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 360;
};

const projectByDistance = ({ lat, lng, bearingDeg, meters }) => {
  const bearing = (Number(bearingDeg) * Math.PI) / 180;
  const dLat = (meters * Math.cos(bearing)) / 111_320;
  const dLng = (meters * Math.sin(bearing)) / (111_320 * Math.cos((lat * Math.PI) / 180));
  return [lat + dLat, lng + dLng];
};

const MapActionButtons = ({ soldiers, selectedSoldier, isDrawerOpen }) => {
  const map = useMap();
  const zoomTimerRef = useRef(null);
  const lastFocusedSoldierRef = useRef("");
  const lastAutoFitBoundsRef = useRef(null);
  const hasInitialFitRef = useRef(false);

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
          if (currentZoom >= maxZoom) return stopZoomLoop();
          map.zoomIn();
        } else {
          if (currentZoom <= minZoom) return stopZoomLoop();
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
    const bounds = L.latLngBounds(soldiers.map((soldier) => [soldier.coordinates.lat, soldier.coordinates.lng]));
    map.fitBounds(bounds, { padding: [22, 22] });
    lastAutoFitBoundsRef.current = computeFleetBounds(soldiers);
  };

  const focusSelected = () => {
    if (!selectedSoldier) return;
    map.panTo([selectedSoldier.coordinates.lat, selectedSoldier.coordinates.lng], { animate: true, duration: 0.7 });
  };

  useEffect(() => {
    if (!selectedSoldier) return;
    if (lastFocusedSoldierRef.current === selectedSoldier.id) return;
    map.panTo([selectedSoldier.coordinates.lat, selectedSoldier.coordinates.lng], { animate: true, duration: 0.7 });
    lastFocusedSoldierRef.current = selectedSoldier.id;
  }, [map, selectedSoldier]);

  useEffect(() => {
    if (!soldiers.length || selectedSoldier) return;

    if (!hasInitialFitRef.current) {
      const bounds = L.latLngBounds(soldiers.map((soldier) => [soldier.coordinates.lat, soldier.coordinates.lng]));
      map.fitBounds(bounds, { padding: [18, 18] });
      lastAutoFitBoundsRef.current = computeFleetBounds(soldiers);
      hasInitialFitRef.current = true;
      lastFocusedSoldierRef.current = "";
      return;
    }

    lastAutoFitBoundsRef.current = computeFleetBounds(soldiers);
    lastFocusedSoldierRef.current = "";
  }, [map, soldiers, selectedSoldier]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const currentCenter = map.getCenter();
      const currentZoom = map.getZoom();
      map.invalidateSize({ animate: false });

      if (selectedSoldier) {
        map.panTo([selectedSoldier.coordinates.lat, selectedSoldier.coordinates.lng], { animate: false });
        return;
      }

      map.setView(currentCenter, currentZoom, { animate: false });
    }, 190);

    return () => window.clearTimeout(timer);
  }, [isDrawerOpen, map, selectedSoldier]);

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

const formatHeartRate = (soldier) => {
  const heartRate = Number(soldier?.source?.heartRate);
  if (Number.isFinite(heartRate) && heartRate > 0) {
    return `${heartRate} bpm`;
  }
  if (
    Number.isFinite(Number(soldier?.bloodPressure?.systolic)) &&
    Number(soldier?.bloodPressure?.systolic) > 0 &&
    Number(soldier?.bloodPressure?.systolic) === Number(soldier?.bloodPressure?.diastolic)
  ) {
    return `${Number(soldier.bloodPressure.systolic)} bpm`;
  }
  return "-";
};

const normalizeSquadIntelForDiff = (value) => {
  if (!value || typeof value !== "object") return value;
  const { timestamp, ...rest } = value;
  return rest;
};

const normalizeSoldierForDiff = (soldier) => ({
  id: soldier.id,
  name: soldier.name,
  altitude: soldier.altitude,
  bloodOxygenLevel: soldier.bloodOxygenLevel,
  bloodPressure: soldier.bloodPressure,
  mapValue: soldier.mapValue,
  map: soldier.map,
  coordinates: soldier.coordinates,
  floor: soldier.floor,
  lifeStatus: soldier.lifeStatus,
  healthStatus: soldier.healthStatus,
  activity: soldier.activity,
  activityConfidence: soldier.activityConfidence,
  imu: {
    headingDeg: soldier.imu.headingDeg,
    stepRateSpm: soldier.imu.stepRateSpm
  },
  engaged: soldier.engaged,
  firing: soldier.firing,
  tampered: soldier.tampered,
  source: soldier.source
});

const soldiersAreEquivalent = (previous, next) =>
  JSON.stringify(normalizeSoldierForDiff(previous)) === JSON.stringify(normalizeSoldierForDiff(next));

const mergeSoldiersForStableRender = (previousSoldiers, incomingSoldiers) => {
  if (!previousSoldiers.length) return incomingSoldiers;

  const previousById = new Map(previousSoldiers.map((soldier) => [soldier.id, soldier]));
  let changed = previousSoldiers.length !== incomingSoldiers.length;

  const merged = incomingSoldiers.map((incoming) => {
    const existing = previousById.get(incoming.id);
    if (!existing) {
      changed = true;
      return incoming;
    }
    if (soldiersAreEquivalent(existing, incoming)) {
      return existing;
    }
    changed = true;
    return incoming;
  });

  return changed ? merged : previousSoldiers;
};

const formatOperationReplayTs = (rawTs, viewMode = "timestamp") => {
  const ts = String(rawTs || "");
  if (!ts) return "unknown time";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  if (viewMode === "time") {
    return new Intl.DateTimeFormat("en-IN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(date);
  }
  return date.toLocaleString("en-IN", { hour12: false });
};

const formatOperationReplayHumanLine = (event, timeViewMode = "timestamp") => {
  const type = String(event?.type || "unknown_event");
  const details = event?.details || {};
  const at = formatOperationReplayTs(event?.timestamp, timeViewMode);

  if (type === "system_start") {
    return `[${at}] System started and Operation Replay logging is active.`;
  }
  if (type === "live_state_snapshot") {
    const count = Number(details?.soldiers?.length || 0);
    return `[${at}] Live battlefield snapshot captured (${count} soldiers).`;
  }
  if (type === "soldier_engage_update") {
    return `[${at}] ${String(details?.id || "Soldier")} engagement status changed.`;
  }
  if (type === "soldier_fire_update") {
    const firing = Boolean(details?.next?.firing);
    return `[${at}] ${String(details?.id || "Soldier")} ${firing ? "started" : "stopped"} firing.`;
  }
  if (type === "watch_audio_event" || type === "audio_detect_firing") {
    return `[${at}] Audio analysis completed for gunfire detection.`;
  }
  if (type === "watch_threat_assessment" || type === "bluetooth_threat_assessment") {
    return `[${at}] Threat assessment generated from incoming battlefield audio.`;
  }
  if (type === "ws_client_connected") {
    return `[${at}] A tactical screen connected to live stream.`;
  }
  if (type === "ws_client_disconnected") {
    return `[${at}] A tactical screen disconnected from live stream.`;
  }
  if (type.endsWith("_error")) {
    return `[${at}] An issue occurred while processing an operation event.`;
  }
  return `[${at}] ${type.replaceAll("_", " ")} recorded.`;
};

export default function App() {
  const drawerTabs = [
    { id: "latest", label: "Latest Update" },
    { id: "summary", label: "Telemetry" },
    { id: "intel", label: "Squad Intel" },
    { id: "replay", label: "Action Replays" },
    { id: "raw", label: "Raw Data" }
  ];
  const [soldiers, setSoldiers] = useState([]);
  const [metrics, setMetrics] = useState(null);
  const [squadIntelligence, setSquadIntelligence] = useState(null);
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
  const [syncMode, setSyncMode] = useState(DEFAULT_SYNC_MODE);
  const [wsStreamStatus, setWsStreamStatus] = useState("connecting");
  const [tacticalPackets, setTacticalPackets] = useState({});
  const [tacticalPaths, setTacticalPaths] = useState({});
  const [operationReplayLogsView, setOperationReplayLogsView] = useState("show");
  const [operationReplayTimeView, setOperationReplayTimeView] = useState("timestamp");
  const [operationReplayMeta, setOperationReplayMeta] = useState({
    files: [],
    latestEvents: [],
    selectedFile: "",
    selectedCount: 0,
    error: ""
  });
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [activeDrawerPanel, setActiveDrawerPanel] = useState("latest");
  const [externalWatchStatus, setExternalWatchStatus] = useState({
    active: false,
    source: DEFAULT_EXTERNAL_WATCH_URL,
    fetchedAt: "",
    error: "",
    placeholderCount: 0,
    gpsKnown: 0,
    rawText: ""
  });
  const [keywordAlertPopup, setKeywordAlertPopup] = useState(null);
  const audioContextRef = useRef(null);
  const alarmIntervalRef = useRef(null);
  const drawerRef = useRef(null);
  const loadInFlightRef = useRef(false);
  const latestSnapshotRef = useRef("");
  const lastSyncUiTimestampRef = useRef(0);
  const lastKeywordAlertIdRef = useRef("");
  const keywordAlertTimerRef = useRef(null);
  const speechRecognitionRef = useRef(null);
  const speechMediaStreamRef = useRef(null);
  const speechKeywordCooldownRef = useRef({ keyword: "", at: 0 });
  const selectedSyncConfig = useMemo(
    () => SYNC_MODES[syncMode] ?? SYNC_MODES[DEFAULT_SYNC_MODE],
    [syncMode]
  );
  const dismissKeywordAlert = useCallback(() => {
    if (keywordAlertTimerRef.current) {
      window.clearTimeout(keywordAlertTimerRef.current);
      keywordAlertTimerRef.current = null;
    }
    setKeywordAlertPopup(null);
  }, []);
  const openKeywordAlertPopup = useCallback((alert) => {
    if (!alert?.id) return;
    lastKeywordAlertIdRef.current = alert.id;
    setKeywordAlertPopup(alert);
    if (keywordAlertTimerRef.current) {
      window.clearTimeout(keywordAlertTimerRef.current);
    }
    keywordAlertTimerRef.current = window.setTimeout(() => {
      setKeywordAlertPopup((current) => (current?.id === alert.id ? null : current));
      keywordAlertTimerRef.current = null;
    }, 6500);
  }, []);

  const showPollingFallback =
    externalWatchStatus.active ||
    !selectedSyncConfig.useLiveStream ||
    streamStatus === "unsupported" ||
    streamStatus === "disconnected";

  useEffect(() => {
    const onPointerDown = (event) => {
      if (!isDrawerOpen) return;
      if (drawerRef.current && !drawerRef.current.contains(event.target)) {
        setIsDrawerOpen(false);
      }
    };

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        setIsDrawerOpen(false);
      }
    };

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isDrawerOpen]);

  useEffect(() => {
    let active = true;

    const loadLatestKeywordAlert = async () => {
      try {
        const response = await fetch(KEYWORD_ALERTS_ENDPOINT, { cache: "no-store" });
        const payload = await response.json();
        const latest = payload?.latest || null;
        if (!active || !latest?.id) return;
        if (lastKeywordAlertIdRef.current === latest.id) return;
        openKeywordAlertPopup(latest);
      } catch (_error) {
        // Ignore transient polling failures for watch keyword alerts.
      }
    };

    loadLatestKeywordAlert();
    const interval = window.setInterval(loadLatestKeywordAlert, 1000);
    return () => {
      active = false;
      window.clearInterval(interval);
      if (keywordAlertTimerRef.current) {
        window.clearTimeout(keywordAlertTimerRef.current);
        keywordAlertTimerRef.current = null;
      }
    };
  }, [openKeywordAlertPopup]);

  useEffect(() => {
    try {
      const persisted = localStorage.getItem(THRESHOLD_STORAGE_KEY);
      if (!persisted) return;
      const parsed = JSON.parse(persisted);
      setAlertThresholds({
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
    if (typeof window === "undefined") return undefined;

    const SpeechRecognitionApi = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionApi) {
      return undefined;
    }

    let stopped = false;
    let retryTimer = null;
    let activated = false;
    let recognitionActive = false;

    const emitLocalKeywordAlert = async (keyword, transcript) => {
      const now = Date.now();
      if (
        speechKeywordCooldownRef.current.keyword === keyword &&
        now - speechKeywordCooldownRef.current.at < 2500
      ) {
        return;
      }

      speechKeywordCooldownRef.current = { keyword, at: now };
      const alert = {
        id: `local-mic-${now}`,
        watchId: "LAPTOP-MIC",
        watchName: "Laptop Mic",
        keyword,
        message: transcript,
        receivedAt: new Date(now).toISOString()
      };
      openKeywordAlertPopup(alert);

      try {
        await fetch(KEYWORD_ALERT_POST_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            watchId: "LAPTOP-MIC",
            watchName: "Laptop Mic",
            keyword,
            message: transcript
          })
        });
      } catch (_error) {
        // Local popup already fired; backend persistence is best-effort only.
      }
    };

    const scheduleRestart = (delayMs = 900) => {
      if (stopped || !activated || recognitionActive) return;
      if (retryTimer) {
        window.clearTimeout(retryTimer);
      }
      retryTimer = window.setTimeout(() => {
        startRecognition();
      }, delayMs);
    };

    const startRecognition = () => {
      if (stopped || !activated || recognitionActive) return;

      const recognition = new SpeechRecognitionApi();
      speechRecognitionRef.current = recognition;
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 5;
      recognition.lang = "en-US";
      recognitionActive = true;

      recognition.onresult = (event) => {
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index];
          const transcript = Array.from(result)
            .map((alternative) => alternative?.transcript || "")
            .join(" ")
            .trim();
          const keyword = detectKeywordFromTranscript(transcript);
          if (keyword) {
            emitLocalKeywordAlert(keyword, transcript);
            break;
          }
        }
      };

      recognition.onerror = () => {
        recognitionActive = false;
        scheduleRestart(1400);
      };

      recognition.onend = () => {
        recognitionActive = false;
        scheduleRestart(700);
      };

      try {
        recognition.start();
      } catch (_error) {
        recognitionActive = false;
        scheduleRestart(1400);
      }
    };

    const activateRecognition = async () => {
      if (activated || stopped) return;
      activated = true;

      try {
        if (navigator.mediaDevices?.getUserMedia) {
          speechMediaStreamRef.current = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true
            }
          });
        }
      } catch (_error) {
        activated = false;
        return;
      }

      startRecognition();
      window.removeEventListener("pointerdown", activateRecognition);
      window.removeEventListener("keydown", activateRecognition);
    };

    window.addEventListener("pointerdown", activateRecognition);
    window.addEventListener("keydown", activateRecognition);

    return () => {
      stopped = true;
      if (retryTimer) {
        window.clearTimeout(retryTimer);
      }
      recognitionActive = false;
      window.removeEventListener("pointerdown", activateRecognition);
      window.removeEventListener("keydown", activateRecognition);
      if (speechRecognitionRef.current) {
        speechRecognitionRef.current.onresult = null;
        speechRecognitionRef.current.onerror = null;
        speechRecognitionRef.current.onend = null;
        try {
          speechRecognitionRef.current.stop();
        } catch (_error) {
          // ignore shutdown errors
        }
      }
      if (speechMediaStreamRef.current) {
        speechMediaStreamRef.current.getTracks().forEach((track) => track.stop());
        speechMediaStreamRef.current = null;
      }
    };
  }, [openKeywordAlertPopup]);


  useEffect(() => {
    let active = true;

    const loadOperationReplay = async () => {
      try {
        const filesRes = await fetch(`${API_BASE}/operation-replay/log-files`, { cache: "no-store" });
        const filesJson = await filesRes.json();
        const files = Array.isArray(filesJson?.files) ? filesJson.files : [];
        const preferredFile = operationReplayMeta.selectedFile || files[0]?.file || "";
        let logsJson = { count: 0, events: [] };
        if (preferredFile) {
          const logsRes = await fetch(
            `${API_BASE}/operation-replay/logs?file=${encodeURIComponent(preferredFile)}&limit=160`,
            { cache: "no-store" }
          );
          logsJson = await logsRes.json();
        }

        if (!active) return;
        setOperationReplayMeta({
          files,
          latestEvents: Array.isArray(logsJson?.events) ? logsJson.events : [],
          selectedFile: preferredFile,
          selectedCount: Number(logsJson?.count || 0),
          error: ""
        });
      } catch (error) {
        if (!active) return;
        setOperationReplayMeta((prev) => ({
          ...prev,
          error: error instanceof Error ? error.message : "Unable to load Operation Replay logs"
        }));
      }
    };

    loadOperationReplay();
    const interval = window.setInterval(loadOperationReplay, 10_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [operationReplayMeta.selectedFile]);

  useEffect(() => {
    localStorage.setItem(THRESHOLD_STORAGE_KEY, JSON.stringify(alertThresholds));
  }, [alertThresholds]);

  useEffect(() => {
    try {
      const persistedMode = localStorage.getItem(SYNC_MODE_STORAGE_KEY);
      if (persistedMode && SYNC_MODES[persistedMode]) {
        setSyncMode(persistedMode);
      }
    } catch (_error) {
      // ignore malformed local data
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(SYNC_MODE_STORAGE_KEY, syncMode);
  }, [syncMode]);

  const applyIncomingData = useCallback((incomingSoldiersRaw, metricJson, squadIntelJson, timestamp = "") => {
    const incomingSoldiers = normalizeSoldiers(incomingSoldiersRaw);
    const nextSyncAt = timestamp || new Date().toISOString();
    const nextSyncMs = new Date(nextSyncAt).getTime() || Date.now();
    const diffReadySoldiers = incomingSoldiers.map((soldier) => normalizeSoldierForDiff(soldier));

    const nextSnapshot = JSON.stringify({
      incomingSoldiers: diffReadySoldiers,
      metricJson,
      squadIntelJson: normalizeSquadIntelForDiff(squadIntelJson)
    });

    if (nextSnapshot !== latestSnapshotRef.current) {
      latestSnapshotRef.current = nextSnapshot;
      setSoldiers((previous) => mergeSoldiersForStableRender(previous, incomingSoldiers));
      setMetrics(metricJson);
      setSquadIntelligence(squadIntelJson);
      setLastRefreshAt(nextSyncAt);
      lastSyncUiTimestampRef.current = nextSyncMs;
      setLiveUpdateCount((prev) => prev + 1);
      setSelectedSoldierId((prev) =>
        incomingSoldiers.some((soldier) => soldier.id === prev) ? prev : (incomingSoldiers[0]?.id || "")
      );
      return;
    }

    // Keep stale detection accurate without forcing full map repaint every second.
    if (!lastSyncUiTimestampRef.current || nextSyncMs - lastSyncUiTimestampRef.current >= 5000) {
      setLastRefreshAt(nextSyncAt);
      lastSyncUiTimestampRef.current = nextSyncMs;
    }
  }, []);

  const loadSnapshot = useCallback(async () => {
    if (loadInFlightRef.current) {
      return;
    }

    loadInFlightRef.current = true;
    const fetchJson = async (url) => {
      const response = await fetch(url, { cache: "no-store" });
      return response.json();
    };

    try {
      try {
        const externalWatchUrl = `${EXTERNAL_WATCH_ENDPOINT}?url=${encodeURIComponent(DEFAULT_EXTERNAL_WATCH_URL)}`;
        const externalWatchJson = await fetchJson(externalWatchUrl);

        if (externalWatchJson?.ok && Array.isArray(externalWatchJson?.soldiers) && externalWatchJson.soldiers.length > 0) {
          setExternalWatchStatus({
            active: true,
            source: String(externalWatchJson.source || DEFAULT_EXTERNAL_WATCH_URL),
            fetchedAt: String(externalWatchJson.fetchedAt || new Date().toISOString()),
            error: "",
            placeholderCount: Number(externalWatchJson?.metrics?.placeholderCount || 0),
            gpsKnown: Number(externalWatchJson?.metrics?.gpsKnown || 0),
            rawText: String(externalWatchJson.rawText || "")
          });
          applyIncomingData(
            externalWatchJson.soldiers,
            externalWatchJson.metrics || null,
            externalWatchJson.squadIntelligence || null,
            externalWatchJson.fetchedAt || ""
          );
          return;
        }

        setExternalWatchStatus((prev) => ({
          ...prev,
          active: false,
          error: String(externalWatchJson?.error || "External watch host unavailable")
        }));
      } catch (error) {
        setExternalWatchStatus((prev) => ({
          ...prev,
          active: false,
          error: error instanceof Error ? error.message : "External watch host unavailable"
        }));
      }

      const [soldierJson, metricJson, squadIntelJson] = await Promise.all([
        fetchJson(`${API_BASE}/soldiers/raw`),
        fetchJson(`${API_BASE}/metrics`),
        fetchJson(`${API_BASE}/intelligence/squad`)
      ]);

      applyIncomingData(soldierJson.data || [], metricJson, squadIntelJson);
    } finally {
      loadInFlightRef.current = false;
    }
  }, [applyIncomingData]);

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        await loadSnapshot();
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    load();

    const onVisible = () => {
      if (document.visibilityState === "visible" && showPollingFallback) {
        load();
      }
    };

    if (!showPollingFallback) {
      setLoading(false);
      document.addEventListener("visibilitychange", onVisible);
      return () => {
        active = false;
        document.removeEventListener("visibilitychange", onVisible);
      };
    }

    load();
    const interval = setInterval(load, selectedSyncConfig.pollIntervalMs);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loadSnapshot, selectedSyncConfig.pollIntervalMs, showPollingFallback]);

  useEffect(() => {
    if (externalWatchStatus.active) {
      setStreamStatus("standby");
      return;
    }

    if (!selectedSyncConfig.useLiveStream) {
      setStreamStatus("standby");
      return;
    }

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
          applyIncomingData(
            payload.soldiers || [],
            payload.metrics || null,
            payload.squadIntelligence || null,
            payload.timestamp || ""
          );
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
  }, [applyIncomingData, externalWatchStatus.active, selectedSyncConfig.useLiveStream]);

  useEffect(() => {
    if (externalWatchStatus.active) {
      setWsStreamStatus("standby");
      return;
    }

    if (typeof window === "undefined" || typeof WebSocket === "undefined") {
      setWsStreamStatus("unsupported");
      return;
    }

    let socket;
    let retryTimer;
    let retryCount = 0;
    let closed = false;

    const wsUrl = (() => {
      const parsed = new URL(API_BASE);
      const protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
      return `${protocol}//${parsed.host}/ws`;
    })();

    const connect = () => {
      if (closed) return;

      setWsStreamStatus(retryCount === 0 ? "connecting" : "reconnecting");
      socket = new WebSocket(wsUrl);

      socket.onopen = () => {
        retryCount = 0;
        setWsStreamStatus("connected");
      };

      socket.onmessage = (event) => {
        try {
          const packet = JSON.parse(event.data);
          const soldierId = String(packet?.soldier_id || "");
          if (!soldierId) return;
          const x = Number(packet?.position?.x);
          const y = Number(packet?.position?.y);
          const lat = Number(packet?.latlng?.lat);
          const lng = Number(packet?.latlng?.lng);
          if (!Number.isFinite(x) || !Number.isFinite(y)) return;

          setTacticalPackets((prev) => {
            const previous = prev[soldierId];
            const prevX = Number(previous?.position?.x);
            const prevY = Number(previous?.position?.y);
            const prevBearing = Number(previous?.gunfire_dir);
            const nextBearing = Number(packet?.gunfire_dir);
            const prevLat = Number(previous?.latlng?.lat);
            const prevLng = Number(previous?.latlng?.lng);

            const unchanged =
              Number.isFinite(prevX) &&
              Number.isFinite(prevY) &&
              Math.abs(prevX - x) < 0.001 &&
              Math.abs(prevY - y) < 0.001 &&
              String(previous?.activity || "") === String(packet?.activity || "") &&
              String(previous?.health || "") === String(packet?.health || "") &&
              ((Number.isFinite(prevBearing) && Number.isFinite(nextBearing) && Math.abs(prevBearing - nextBearing) < 0.001) ||
                (!Number.isFinite(prevBearing) && !Number.isFinite(nextBearing))) &&
              ((Number.isFinite(prevLat) && Number.isFinite(lat) && Math.abs(prevLat - lat) < 0.000001) ||
                (!Number.isFinite(prevLat) && !Number.isFinite(lat))) &&
              ((Number.isFinite(prevLng) && Number.isFinite(lng) && Math.abs(prevLng - lng) < 0.000001) ||
                (!Number.isFinite(prevLng) && !Number.isFinite(lng)));

            if (unchanged) return prev;
            return {
              ...prev,
              [soldierId]: packet
            };
          });

          setTacticalPaths((prev) => {
            const existing = prev[soldierId] || [];
            const lastPoint = existing[existing.length - 1];
            if (lastPoint) {
              const sameXY = Math.abs(Number(lastPoint.x) - x) < 0.25 && Math.abs(Number(lastPoint.y) - y) < 0.25;
              const sameLatLng =
                ((Number.isFinite(Number(lastPoint.lat)) && Number.isFinite(lat) && Math.abs(Number(lastPoint.lat) - lat) < 0.000002) ||
                  (!Number.isFinite(Number(lastPoint.lat)) && !Number.isFinite(lat))) &&
                ((Number.isFinite(Number(lastPoint.lng)) && Number.isFinite(lng) && Math.abs(Number(lastPoint.lng) - lng) < 0.000002) ||
                  (!Number.isFinite(Number(lastPoint.lng)) && !Number.isFinite(lng)));
              if (sameXY && sameLatLng) {
                return prev;
              }
            }

            const nextPath = [
              ...existing,
              {
                x,
                y,
                lat: Number.isFinite(lat) ? lat : null,
                lng: Number.isFinite(lng) ? lng : null,
                timestamp: packet?.timestamp || Date.now()
              }
            ];
            if (nextPath.length > 40) {
              nextPath.splice(0, nextPath.length - 40);
            }
            return {
              ...prev,
              [soldierId]: nextPath
            };
          });
        } catch (_error) {
          // Ignore malformed websocket packet.
        }
      };

      socket.onclose = () => {
        if (closed) return;
        setWsStreamStatus("disconnected");
        const delay = Math.min(10_000, 1000 * 2 ** retryCount);
        retryCount += 1;
        retryTimer = window.setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      closed = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.close();
      }
    };
  }, [externalWatchStatus.active]);

  useEffect(() => {
    const checkStale = () => {
      if (!lastRefreshAt) {
        setIsStale(true);
        return;
      }

      const ageMs = Date.now() - new Date(lastRefreshAt).getTime();
      setIsStale(ageMs > selectedSyncConfig.staleAfterMs);
    };

    checkStale();
    const interval = window.setInterval(checkStale, 1000);
    return () => window.clearInterval(interval);
  }, [lastRefreshAt, selectedSyncConfig.staleAfterMs]);

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
      (acc, soldier) => ({
        lat: acc.lat + soldier.coordinates.lat,
        lng: acc.lng + soldier.coordinates.lng
      }),
      { lat: 0, lng: 0 }
    );
    return [aggregate.lat / soldiers.length, aggregate.lng / soldiers.length];
  }, [soldiers]);

  const sectorOverlays = useMemo(() => {
    const grouped = new Map();
    soldiers.forEach((soldier) => {
      const key = soldier.map || "Unknown";
      if (!grouped.has(key)) {
        grouped.set(key, {
          name: key,
          count: 0,
          latSum: 0,
          lngSum: 0
        });
      }
      const row = grouped.get(key);
      row.count += 1;
      row.latSum += soldier.coordinates.lat;
      row.lngSum += soldier.coordinates.lng;
    });

    return [...grouped.values()].map((row, index) => ({
      ...row,
      lat: row.latSum / Math.max(1, row.count),
      lng: row.lngSum / Math.max(1, row.count),
      terrainRadius: 130 + index * 25,
      mountainRadius: 55 + index * 15,
      forestRadius: 85 + index * 18
    }));
  }, [soldiers]);

  const directionVectors = useMemo(() => {
    return soldiers
      .map((soldier) => {
        const packet = tacticalPackets[soldier.id];
        const bearing = Number(packet?.gunfire_dir);
        const headingDeg = Number.isFinite(bearing) ? bearing : getDummyBearing(soldier.id);
        const start = [soldier.coordinates.lat, soldier.coordinates.lng];
        const end = projectByDistance({
          lat: soldier.coordinates.lat,
          lng: soldier.coordinates.lng,
          bearingDeg: headingDeg,
          meters: soldier.firing ? 80 : 45
        });
        return {
          id: soldier.id,
          firing: soldier.firing,
          bearingDeg: headingDeg,
          points: [start, end],
          arrowAt: end
        };
      })
      .filter(Boolean);
  }, [soldiers, tacticalPackets]);

  const gunfireDetections = useMemo(() => {
    return directionVectors
      .filter((vector) => vector.firing)
      .map((vector) => {
        const [originLat, originLng] = vector.points[0];
        const leftEdge = projectByDistance({
          lat: originLat,
          lng: originLng,
          bearingDeg: vector.bearingDeg - 22,
          meters: 95
        });
        const rightEdge = projectByDistance({
          lat: originLat,
          lng: originLng,
          bearingDeg: vector.bearingDeg + 22,
          meters: 95
        });

        return {
          id: vector.id,
          origin: [originLat, originLng],
          cone: [[originLat, originLng], leftEdge, rightEdge],
          innerRadius: 26,
          outerRadius: 58
        };
      });
  }, [directionVectors]);

  const soldierMarkers = useMemo(() => {
    return soldiers.map((soldier) => (
      <Marker
        key={soldier.id}
        position={[soldier.coordinates.lat, soldier.coordinates.lng]}
        icon={markerIcon(soldier, soldier.id === selectedSoldierId)}
        eventHandlers={{
          click: () => setSelectedSoldierId(soldier.id)
        }}
      >
        <Tooltip direction="top" offset={[0, -10]} opacity={0.9}>
          {soldier.id} | F{soldier.floor} | {soldier.map}
        </Tooltip>
      </Marker>
    ));
  }, [selectedSoldierId, soldiers]);

  const operationReplayFormatSample = useMemo(() => {
    const sample = operationReplayMeta.latestEvents[0];
    if (!sample) return null;
    return {
      seq: sample.seq,
      timestamp: sample.timestamp,
      ts: sample.ts,
      type: sample.type,
      details: sample.details
    };
  }, [operationReplayMeta.latestEvents]);

  const operationReplayReadableTimeline = useMemo(() => {
    return operationReplayMeta.latestEvents
      .slice(-25)
      .reverse()
      .map((event) => ({
        key: `${String(event.seq)}-${String(event.type)}`,
        text: formatOperationReplayHumanLine(event, operationReplayTimeView)
      }));
  }, [operationReplayMeta.latestEvents, operationReplayTimeView]);

  const squadPatternCards = useMemo(() => {
    if (!squadIntelligence) return [];
    const patterns = squadIntelligence.patterns || {};
    return [
      {
        key: "ambush",
        label: "Ambush Detection",
        detected: Boolean(patterns?.ambushDetection?.detected),
        facts: [
          `Gunfire: ${patterns?.ambushDetection?.gunfireDetected ? "Yes" : "No"}`,
          `Sudden Stops: ${Number(patterns?.ambushDetection?.suddenStops || 0)}`
        ]
      },
      {
        key: "split",
        label: "Squad Split",
        detected: Boolean(patterns?.squadSplit?.detected),
        facts: [
          `Max Distance: ${Number(patterns?.squadSplit?.maxDistanceMeters || 0)}m`,
          `Threshold: ${Number(patterns?.squadSplit?.thresholdMeters || 0)}m`
        ]
      },
      {
        key: "movement",
        label: "Coordinated Movement",
        detected: Boolean(patterns?.coordinatedMovement?.detected),
        facts: [
          `Parallel Score: ${Number(patterns?.coordinatedMovement?.parallelScore || 0)}`,
          `Moving Units: ${Number(patterns?.coordinatedMovement?.movingSoldiers || 0)}`
        ]
      },
      {
        key: "isolation",
        label: "Soldier Isolation",
        detected: Boolean(patterns?.soldierIsolation?.detected),
        facts: [
          `Isolated: ${Number(patterns?.soldierIsolation?.isolatedCount || 0)}`,
          `Threshold: ${Number(patterns?.soldierIsolation?.thresholdMeters || 80)}m`
        ]
      }
    ];
  }, [squadIntelligence]);

  const squadAlertRows = useMemo(() => {
    if (!Array.isArray(squadIntelligence?.alerts)) return [];
    return squadIntelligence.alerts.map((alert, index) => ({
      key: `${String(alert.type)}-${index}`,
      title: String(alert.title || "Alert"),
      message: String(alert.message || ""),
      severity: String(alert.severity || "info").toLowerCase()
    }));
  }, [squadIntelligence]);

  const alertFeedItems = useMemo(() => {
    const items = [];

    items.push({
      key: "watch-feed",
      severity: externalWatchStatus.active ? "info" : "warning",
      title: externalWatchStatus.active ? "External Watch Feed Active" : "External Watch Feed Fallback",
      message: `GPS fixes ${externalWatchStatus.gpsKnown} | placeholders ${externalWatchStatus.placeholderCount}${externalWatchStatus.error ? ` | ${externalWatchStatus.error}` : ""}`
    });

    if (isStale) {
      items.push({
        key: "stale",
        severity: "critical",
        title: "Data Stale",
        message: `No new telemetry for more than ${selectedSyncConfig.staleAfterMs / 1000}s. Check watch uplink/network.`
      });
    }

    if (alarmViolations.length > 0) {
      alarmViolations.forEach((violation) => {
        items.push({
          key: `v-${violation.id}`,
          severity: "critical",
          title: violation.id,
          message: violation.reasons.join(" | ")
        });
      });
    } else {
      items.push({
        key: "monitoring-stable",
        severity: "info",
        title: "Monitoring Stable",
        message: `MAP threshold ${alertThresholds.mapValue.min}-${alertThresholds.mapValue.max} | Audio ${audioArmed ? "ready" : "not enabled"}`
      });
    }

    squadAlertRows.forEach((alert) => {
      items.push({
        key: `s-${alert.key}`,
        severity: alert.severity,
        title: alert.title,
        message: alert.message
      });
    });

    return items;
  }, [
    alarmViolations,
    alertThresholds.mapValue.max,
    alertThresholds.mapValue.min,
    audioArmed,
    externalWatchStatus.active,
    externalWatchStatus.error,
    externalWatchStatus.gpsKnown,
    externalWatchStatus.placeholderCount,
    isStale,
    selectedSyncConfig.staleAfterMs,
    squadAlertRows
  ]);

  const keywordAlertSeverityClass = useMemo(() => {
    const keyword = String(keywordAlertPopup?.keyword || "").toUpperCase();
    if (keyword === "ENEMY" || keyword === "AMBUSH") return "keyword-alert-critical";
    if (keyword === "HELP") return "keyword-alert-warning";
    return "keyword-alert-info";
  }, [keywordAlertPopup]);

  const renderDrawerPanel = () => {
    if (activeDrawerPanel === "latest") {
      return (
        <article className="panel latest-panel drawer-panel">
          <h2>Latest Soldier Update</h2>
          {selectedSoldier ? (
            <>
              <p className="activity-callout">
                {selectedSoldier.name} is {selectedSoldier.activity}
              </p>
              <div className="detail-grid">
                <div className="detail-row"><span>ID</span><strong>{selectedSoldier.id}</strong></div>
                <div className="detail-row"><span>Map</span><strong>{selectedSoldier.map}</strong></div>
                <div className="detail-row"><span>Coordinates</span><strong>{selectedSoldier.coordinates.lat}, {selectedSoldier.coordinates.lng}</strong></div>
                <div className="detail-row"><span>Activity</span><strong>{selectedSoldier.activity}</strong></div>
                <div className="detail-row"><span>Activity Confidence</span><strong>{Math.round(selectedSoldier.activityConfidence * 100)}%</strong></div>
                <div className="detail-row"><span>IMU Heading</span><strong>{selectedSoldier.imu.headingDeg == null ? "-" : `${Math.round(selectedSoldier.imu.headingDeg)}°`}</strong></div>
                <div className="detail-row"><span>Step Rate</span><strong>{selectedSoldier.imu.stepRateSpm == null ? "-" : `${Math.round(selectedSoldier.imu.stepRateSpm)} spm`}</strong></div>
                <div className="detail-row"><span>Altitude</span><strong>{selectedSoldier.altitude}</strong></div>
                <div className="detail-row"><span>Blood Oxygen</span><strong>{selectedSoldier.bloodOxygenLevel}</strong></div>
                <div className="detail-row"><span>Heart Rate</span><strong>{formatHeartRate(selectedSoldier)}</strong></div>
                <div className="detail-row"><span>MAP</span><strong>{selectedSoldier.mapValue}</strong></div>
                <div className="detail-row"><span>Floor</span><strong>{selectedSoldier.floor}</strong></div>
                <div className="detail-row"><span>Life</span><strong>{selectedSoldier.lifeStatus}</strong></div>
                <div className="detail-row"><span>Health</span><strong>{selectedSoldier.healthStatus}</strong></div>
                <div className="detail-row"><span>Tampered</span><strong>{selectedSoldier.tampered ? "YES" : "NO"}</strong></div>
                <div className="detail-row"><span>Engage</span><strong>{selectedSoldier.engaged ? "YES" : "NO"}</strong></div>
                <div className="detail-row"><span>Fire</span><strong>{selectedSoldier.firing ? "YES" : "NO"}</strong></div>
                <div className="detail-row"><span>GPS Source</span><strong>{selectedSoldier.source?.placeholderPosition ? "PLACEHOLDER" : "LIVE FIX"}</strong></div>
                <div className="detail-row"><span>RSSI</span><strong>{selectedSoldier.source?.rssi ?? "-"}</strong></div>
                <div className="detail-row"><span>Distance</span><strong>{selectedSoldier.source?.distanceMeters == null ? "-" : `${selectedSoldier.source.distanceMeters} m`}</strong></div>
              </div>
            </>
          ) : (
            <p>Select a soldier marker on the 2D map to view latest updates.</p>
          )}
        </article>
      );
    }

    if (activeDrawerPanel === "summary") {
      return (
        <article className="panel drawer-panel">
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
      );
    }

    if (activeDrawerPanel === "intel") {
      return (
        <article className="panel drawer-panel">
          <h2>Squad-Level Data Intelligence</h2>
          {squadIntelligence ? (
            <div className="squad-war-intel">
              <div className="squad-war-strip">
                <div className="squad-war-kpi"><span>Algorithm</span><strong>{String(squadIntelligence.algorithm || "rule_based+statistical")}</strong></div>
                <div className="squad-war-kpi"><span>Alive Units</span><strong>{Number(squadIntelligence.stats?.aliveUnits || 0)}</strong></div>
                <div className="squad-war-kpi"><span>Avg Speed</span><strong>{Number(squadIntelligence.stats?.avgSpeedMps || 0)} m/s</strong></div>
                <div className="squad-war-kpi"><span>Active Alerts</span><strong>{squadAlertRows.length}</strong></div>
              </div>
              <div className="squad-war-pattern-grid">
                {squadPatternCards.map((pattern) => (
                  <div key={pattern.key} className={`squad-war-pattern ${pattern.detected ? "pattern-detected" : "pattern-clear"}`}>
                    <div className="squad-war-pattern-head">
                      <strong>{pattern.label}</strong>
                      <span>{pattern.detected ? "DETECTED" : "CLEAR"}</span>
                    </div>
                    <div className="squad-war-facts">
                      {pattern.facts.map((fact) => <p key={`${pattern.key}-${fact}`}>{fact}</p>)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p>Squad intelligence feed pending...</p>
          )}
        </article>
      );
    }

    if (activeDrawerPanel === "replay") {
      return (
        <article className="panel drawer-panel replay-panel">
          <div className="replay-head">
            <div>
              <h2>Action Replays</h2>
              <p className="replay-subtitle">Recent battlefield events and replay snapshots from the live feed.</p>
            </div>
            <div className="replay-filters">
              <label className="sync-mode-control replay-filter">
                <span>Logs Visibility</span>
                <select value={operationReplayLogsView} onChange={(event) => setOperationReplayLogsView(event.target.value)} aria-label="Operation replay logs visibility">
                  <option value="show">Show Logs</option>
                  <option value="hide">Hide Logs</option>
                </select>
              </label>
              <label className="sync-mode-control replay-filter">
                <span>Timestamp View</span>
                <select value={operationReplayTimeView} onChange={(event) => setOperationReplayTimeView(event.target.value)} aria-label="Operation replay timestamp view">
                  <option value="timestamp">Timestamp</option>
                  <option value="time">Time Only</option>
                </select>
              </label>
            </div>
          </div>
          <div className="replay-stats">
            <div className="stat"><span>Replay Files</span><strong>{operationReplayMeta.files.length}</strong></div>
            <div className="stat"><span>Loaded Events</span><strong>{operationReplayMeta.latestEvents.length}</strong></div>
            <div className="stat"><span>Total Events</span><strong>{operationReplayMeta.selectedCount}</strong></div>
          </div>
          {operationReplayMeta.error ? <p className="replay-error">{operationReplayMeta.error}</p> : null}
          {operationReplayLogsView === "show" && operationReplayMeta.latestEvents.length > 0 ? (
            <div className="operation-replay-readable-list replay-timeline">
              {operationReplayReadableTimeline.map((item) => (
                <div key={item.key} className="operation-replay-readable-item">{item.text}</div>
              ))}
            </div>
          ) : (
            <div className="replay-empty">Operation replay timeline hidden or unavailable.</div>
          )}
        </article>
      );
    }

    return (
      <article className="panel drawer-panel">
        <h2>Soldier Raw Data ({soldierCount})</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Altitude</th>
                <th>Blood O2</th>
                <th>Heart Rate</th>
                <th>MAP</th>
                <th>Map</th>
                <th>Coordinates</th>
                <th>Activity</th>
                <th>Floor</th>
                <th>Status</th>
                <th>Engage</th>
                <th>Fire</th>
              </tr>
            </thead>
            <tbody>
              {soldiers.map((soldier) => (
                <tr key={soldier.id} className={soldier.id === selectedSoldierId ? "row-selected" : ""} onClick={() => setSelectedSoldierId(soldier.id)}>
                  <td>{soldier.id}</td>
                  <td>{soldier.altitude}</td>
                  <td>{soldier.bloodOxygenLevel}</td>
                  <td>{formatHeartRate(soldier)}</td>
                  <td>{soldier.mapValue}</td>
                  <td>{soldier.map}</td>
                  <td>{soldier.coordinates.lat}, {soldier.coordinates.lng}</td>
                  <td>{soldier.activity}</td>
                  <td>{soldier.floor}</td>
                  <td><span className={`pill ${statusColorClass(soldier)}`}>{soldier.tampered ? "tampered" : soldier.lifeStatus === "dead" ? "dead" : soldier.healthStatus}</span></td>
                  <td>{soldier.engaged ? "YES" : "NO"}</td>
                  <td>{soldier.firing ? "YES" : "NO"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </article>
    );
  };

  return (
    <main className="page">
      {keywordAlertPopup ? (
        <aside className={`keyword-alert-popup ${keywordAlertSeverityClass}`}>
          <button type="button" className="keyword-alert-close" aria-label="Dismiss keyword alert" onClick={dismissKeywordAlert}>×</button>
          <div className="keyword-alert-head">Watch Alert</div>
          <div className="keyword-alert-row">
            <span>Watch Name</span>
            <strong>{keywordAlertPopup.watchName || keywordAlertPopup.watchId || "Unknown Watch"}</strong>
          </div>
          <div className="keyword-alert-row">
            <span>Keyword</span>
            <strong>{keywordAlertPopup.keyword}</strong>
          </div>
        </aside>
      ) : null}
      <header className="topbar">
        <div className="topbar-title-row">
          <div className="topbar-left-controls">
            <aside className={`hud-drawer ${isDrawerOpen ? "hud-drawer-open" : ""}`} ref={drawerRef}>
              <button
                type="button"
                className="hud-drawer-trigger"
                aria-label={isDrawerOpen ? "Close tactical panels" : "Open tactical panels"}
                aria-expanded={isDrawerOpen}
                onClick={() => setIsDrawerOpen((prev) => !prev)}
              >
                <span className="hamburger-lines" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
                <strong>Menu</strong>
              </button>
              <div className="hud-drawer-sheet">
                <div className="drawer-nav">
                  {drawerTabs.map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      className={`drawer-nav-item ${activeDrawerPanel === tab.id ? "drawer-nav-item-active" : ""}`}
                      onClick={() => setActiveDrawerPanel(tab.id)}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
                <div className="drawer-content">
                  {renderDrawerPanel()}
                </div>
              </div>
            </aside>
          </div>
          <div className="topbar-heading-block">
            <h1>War Room Tactical Dashboard</h1>
            <small className="sync-text sync-text-centered">
              Mode: {selectedSyncConfig.label.toUpperCase()} ({selectedSyncConfig.description})
            </small>
          </div>
          <label className="sync-mode-control">
            <span>Sync Mode</span>
            <select
              value={syncMode}
              onChange={(event) => setSyncMode(event.target.value)}
              aria-label="Select network intelligence mode"
            >
              {Object.entries(SYNC_MODES).map(([mode, config]) => (
                <option key={mode} value={mode}>
                  {config.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="topbar-meta">
          <small className="sync-text">Latest feed sync: {formattedLastSync}</small>
          <small className="sync-text">
            Live feed: {streamStatus.toUpperCase()} | Poll fallback: {showPollingFallback ? `${selectedSyncConfig.pollIntervalMs / 1000}s` : "disabled"} | Changes applied: {liveUpdateCount}
          </small>
        </div>
      </header>

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

      {loading ? <div className="loading">Loading data...</div> : null}

      <section className={`tactical-layout ${isDrawerOpen ? "drawer-open" : ""}`}>
        <div className="map-stage">
        <article className="panel map-panel">
          <h2>2D Tactical Map</h2>
          <p className="three-status">
            WebSocket Stream: {wsStreamStatus.toUpperCase()} | Packets tracked: {Object.keys(tacticalPackets).length}
          </p>
          <div className="map-box osm-map-box">
            <MapContainer center={mapCenter} zoom={18} scrollWheelZoom className="osm-map" maxZoom={22}>
              <TileLayer
                attribution='&copy; OpenStreetMap contributors'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                maxZoom={22}
                maxNativeZoom={19}
              />
              <MapActionButtons soldiers={soldiers} selectedSoldier={selectedSoldier} isDrawerOpen={isDrawerOpen} />

              {sectorOverlays.map((sector, index) => (
                <Circle
                  key={`${sector.name}-forest-${index}`}
                  center={[sector.lat + 0.00032, sector.lng - 0.00025]}
                  radius={sector.forestRadius}
                  pathOptions={{ color: "#3e8d4f", fillColor: "#4fa866", fillOpacity: 0.15, dashArray: "4 6", weight: 1.2 }}
                />
              ))}

              {sectorOverlays.map((sector, index) => (
                <Polygon
                  key={`${sector.name}-mountain-${index}`}
                  positions={[
                    [sector.lat - 0.00025, sector.lng + 0.0002],
                    [sector.lat + 0.0001, sector.lng + 0.00055],
                    [sector.lat + 0.00035, sector.lng + 0.00015]
                  ]}
                  pathOptions={{ color: "#9b7d5b", fillColor: "#b39874", fillOpacity: 0.2, weight: 1.2 }}
                />
              ))}

              {Object.entries(tacticalPaths).map(([soldierId, pathPoints]) => {
                const points = pathPoints
                  .map((point) =>
                    Number.isFinite(point.lat) && Number.isFinite(point.lng) ? [point.lat, point.lng] : null
                  )
                  .filter(Boolean);
                if (points.length < 2) return null;
                return (
                  <Polyline
                    key={`path-${soldierId}`}
                    positions={points}
                    pathOptions={{ color: "#5fd1ff", weight: 2.2, opacity: 0.72 }}
                  />
                );
              })}

              {directionVectors.map((vector) => (
                <Polyline
                  key={`dir-line-${vector.id}`}
                  positions={vector.points}
                  pathOptions={{
                    color: vector.firing ? "#ff8a6f" : "#f5cc72",
                    weight: vector.firing ? 1.8 : 1.6,
                    opacity: vector.firing ? 0.48 : 0.42
                  }}
                />
              ))}

              {directionVectors.map((vector) => (
                <Marker
                  key={`dir-arrow-${vector.id}`}
                  position={vector.arrowAt}
                  icon={directionArrowIcon({ bearingDeg: vector.bearingDeg, active: vector.firing })}
                  interactive={false}
                />
              ))}

              {gunfireDetections.map((gunfire) => (
                <Circle
                  key={`gunfire-core-${gunfire.id}`}
                  center={gunfire.origin}
                  radius={gunfire.innerRadius * 0.75}
                  pathOptions={{ color: "#ff4a3c", fillColor: "#ff4a3c", fillOpacity: 0.34, weight: 0.6, opacity: 0.38 }}
                />
              ))}

              {gunfireDetections.map((gunfire) => (
                <Circle
                  key={`gunfire-mid-${gunfire.id}`}
                  center={gunfire.origin}
                  radius={gunfire.outerRadius * 0.78}
                  pathOptions={{ color: "#ff7a62", fillColor: "#ff7a62", fillOpacity: 0.2, weight: 0.5, opacity: 0.3 }}
                />
              ))}

              {gunfireDetections.map((gunfire) => (
                <Circle
                  key={`gunfire-falloff-${gunfire.id}`}
                  center={gunfire.origin}
                  radius={gunfire.outerRadius * 1.15}
                  pathOptions={{ color: "#ff9d81", fillColor: "#ff9d81", fillOpacity: 0.11, weight: 0.4, opacity: 0.2 }}
                />
              ))}

              {gunfireDetections.map((gunfire) => (
                <Polygon
                  key={`gunfire-cone-${gunfire.id}`}
                  positions={gunfire.cone}
                  pathOptions={{ color: "#ff8a6f", fillColor: "#ff8a6f", fillOpacity: 0.09, weight: 0.3, opacity: 0.22 }}
                />
              ))}

              {soldierMarkers}
            </MapContainer>
            <div className="map-compass" aria-hidden="true">
              <span className="map-compass-label">N</span>
              <div className="map-compass-middle">
                <span>W</span>
                <span className="map-compass-center" />
                <span>E</span>
              </div>
              <span className="map-compass-label">S</span>
            </div>
          </div>
          <div className="legend">
            <span><i className="dot-icon" />Floor 0 = Dot</span>
            <span><i className="triangle-icon" />Floor &gt; 0 = Triangle</span>
            <span><i className="legend-color" style={{ backgroundColor: "#5fd1ff" }} />Squad Path</span>
            <span><i className="legend-color" style={{ backgroundColor: "#ff5a4b" }} />Direction / Fire Vector</span>
            <span><i className="legend-color" style={{ backgroundColor: "#ff8e72" }} />Gunfire Detection Zone</span>
            <span><i className="legend-color" style={{ backgroundColor: "#4fa866" }} />Forest Zone</span>
            <span><i className="legend-color" style={{ backgroundColor: "#b39874" }} />Mountain Zone</span>
            <span><i className="legend-color status-yellow" />Injured</span>
            <span><i className="legend-color status-white" />Dead</span>
            <span><i className="legend-color status-green" />Healthy</span>
            <span><i className="legend-color status-red" />Tampered</span>
          </div>
        </article>
        </div>

        <aside className="panel alert-sidebar">
          <div className="alert-sidebar-head">
            <div>
              <h2>Alert Console</h2>
              <p>Live operational alerts, health flags, and squad warnings.</p>
            </div>
            <div className="alert-sidebar-actions">
              <button type="button" onClick={onAlarmButtonClick}>
                {!audioArmed ? "Enable Alarm Audio" : alarmEnabled ? "Mute Alarm" : "Unmute Alarm"}
              </button>
              <button type="button" onClick={() => setIsThresholdModalOpen(true)}>Set Thresholds</button>
            </div>
          </div>
          <div className="alert-sidebar-meta">
            <span>External watch: {externalWatchStatus.active ? "LIVE" : "FALLBACK"}</span>
            <span>{externalWatchStatus.fetchedAt ? `Last poll ${new Date(externalWatchStatus.fetchedAt).toLocaleTimeString("en-IN", { hour12: false })}` : "Awaiting poll"}</span>
          </div>
          <div className="alert-sidebar-list">
            {alertFeedItems.map((item) => (
              <div key={item.key} className={`alert-console-item severity-${item.severity}`}>
                <strong>{item.title}</strong>
                <span>{item.message}</span>
              </div>
            ))}
          </div>
        </aside>
      </section>
    </main>
  );
}
