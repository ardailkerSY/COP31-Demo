"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import Image from "next/image";
import DamTwinCanvas from "@/components/DamTwinCanvas";
import TelemetryChart from "@/components/TelemetryChart";
import RiskGauge from "@/components/RiskGauge";
import {
  ShieldAlert,
  Activity,
  Radio,
  Sliders,
  TrendingUp,
  RotateCcw,
  Zap,
  Building2,
  Waves,
  Play,
  Square,
  ListFilter,
  Droplets,
  Waves as WaveIcon,
  Settings2,
} from "lucide-react";
import {
  SENSOR_META,
  SCENARIOS,
  readSensors,
  computeRisk,
  recommendedProtocol,
  sampleScenario,
  type EventLevel,
  type SensorStatus,
} from "@/lib/damModel";

const HISTORY_POINTS = 28;
const TICK_MS = 2000;

/** Demonstration site — not a real facility. Single source for every on-screen mention. */
const FACILITY_NAME = "Demo Dam (Block 04)";

/**
 * Brand lockup with Sidara as the lead identity, SuYapı stacked underneath,
 * and PARA displayed as a dedicated supporting mark.
 */
const SIDARA_LOGO = {
  src: "/logos/para-sidara-on-dark.svg",
  alt: "Sidara",
  width: 240,
  height: 31,
} as const;

const SUYAPI_LOGO = {
  src: "/logos/su-yapi-on-dark.png",
  alt: "SU YAPI Engineering & Consulting",
  width: 1280,
  height: 203,
} as const;

const PARA_LOGO = {
  src: "/logos/para-sidara-on-dark.svg",
  alt: "PARA",
  width: 240,
  height: 31,
} as const;

/** Relative x labels — pure function of index, so no clock skew or hydration drift. */
const TIME_LABELS = Array.from({ length: HISTORY_POINTS }, (_, i) => {
  const secondsAgo = (HISTORY_POINTS - 1 - i) * (TICK_MS / 1000);
  return secondsAgo === 0 ? "now" : `-${secondsAgo}s`;
});

/** Deterministic seed history so charts are populated on first paint. */
function seedHistory(
  base: number,
  amplitude: number,
  decimals: number,
): number[] {
  return Array.from({ length: HISTORY_POINTS }, (_, i) =>
    parseFloat(
      (
        base +
        Math.sin(i * 0.7) * amplitude +
        Math.cos(i * 0.31) * amplitude * 0.4
      ).toFixed(decimals),
    ),
  );
}

interface LogEntry {
  id: number;
  time: string;
  level: EventLevel;
  text: string;
}

const SEED_LOG: LogEntry[] = [
  {
    id: -1,
    time: "09:42:10",
    level: "success",
    text: "Automated integrity self-test passed — 6/6 structural nodes reporting.",
  },
  {
    id: -2,
    time: "09:41:55",
    level: "info",
    text: "Telemetry uplink established. Physics model synchronised to twin.",
  },
];

const LEVEL_STYLES: Record<EventLevel, { dot: string; text: string }> = {
  critical: { dot: "bg-red-500", text: "text-red-300" },
  warning: { dot: "bg-amber-500", text: "text-amber-300" },
  success: { dot: "bg-emerald-500", text: "text-emerald-300" },
  info: { dot: "bg-sky-500", text: "text-gray-300" },
};

const STATUS_TEXT: Record<SensorStatus, string> = {
  normal: "text-emerald-400",
  warning: "text-amber-400",
  critical: "text-red-400",
};

const SCENARIO_ICONS: Record<string, typeof Droplets> = {
  flood: Droplets,
  seismic: WaveIcon,
  gate: Settings2,
};

export default function DamMonitoringDashboard() {
  const [selectedSensorId, setSelectedSensorId] = useState<string>("P-01");

  // Simulator inputs
  const [surge, setSurge] = useState(0);
  const [pga, setPga] = useState(0.02);
  const [spillwayGate, setSpillwayGate] = useState(100);

  // Scenario runner
  const [activeScenarioId, setActiveScenarioId] = useState<string | null>(null);
  const [scenarioProgress, setScenarioProgress] = useState(0);
  const [log, setLog] = useState<LogEntry[]>(SEED_LOG);
  const logId = useRef(0);

  // Only a human picking a sensor should move the camera; scenario scripts
  // change the selection to steer the charts but leave the framing alone.
  const [focusNonce, setFocusNonce] = useState(0);
  const selectSensor = useCallback((id: string) => {
    setSelectedSensorId(id);
    setFocusNonce((n) => n + 1);
  }, []);

  // Derived — no state sync, no effects.
  const sensors = useMemo(
    () => readSensors({ surge, pga, spillwayGate }),
    [surge, pga, spillwayGate],
  );
  const risk = useMemo(
    () => computeRisk({ surge, pga, spillwayGate }),
    [surge, pga, spillwayGate],
  );
  const protocol = useMemo(() => recommendedProtocol(risk), [risk]);
  const selectedSensor =
    sensors.find((s) => s.id === selectedSensorId) ?? sensors[0];
  const activeScenario =
    SCENARIOS.find((s) => s.id === activeScenarioId) ?? null;

  const alarmCount = sensors.filter((s) => s.status !== "normal").length;

  // Rolling histories, keyed by sensor id, plus the derived risk trace.
  const [histories, setHistories] = useState<Record<string, number[]>>(() =>
    Object.fromEntries(
      SENSOR_META.map((m) => [
        m.id,
        seedHistory(m.base, m.base * 0.004, m.decimals),
      ]),
    ),
  );
  const [riskHistory, setRiskHistory] = useState<number[]>(() =>
    seedHistory(12, 0.5, 1),
  );

  // The sampler reads live values through a ref so the interval never restarts
  // when a slider moves (which previously reset the telemetry clock).
  const sampleRef = useRef({ sensors, risk });
  useEffect(() => {
    sampleRef.current = { sensors, risk };
  }, [sensors, risk]);

  useEffect(() => {
    const interval = setInterval(() => {
      const { sensors: cur, risk: curRisk } = sampleRef.current;
      setHistories((prev) => {
        const next: Record<string, number[]> = {};
        for (const s of cur) {
          const jitter =
            (Math.random() - 0.5) * Math.max(0.05, s.value * 0.0015);
          next[s.id] = [
            ...(prev[s.id] ?? []).slice(1),
            parseFloat((s.value + jitter).toFixed(s.decimals)),
          ];
        }
        return next;
      });
      setRiskHistory((prev) => [
        ...prev.slice(1),
        parseFloat(curRisk.score.toFixed(1)),
      ]);
    }, TICK_MS);
    return () => clearInterval(interval);
  }, []);

  const pushLog = useCallback((level: EventLevel, text: string) => {
    logId.current += 1;
    const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
    setLog((prev) =>
      [{ id: logId.current, time, level, text }, ...prev].slice(0, 40),
    );
  }, []);

  // Scenario clock: one rAF loop drives sliders, twin, charts and gauge.
  useEffect(() => {
    if (!activeScenario) return;
    let raf = 0;
    let fired = 0;
    const start = performance.now();

    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / activeScenario.durationMs);
      const s = sampleScenario(activeScenario, p);
      setSurge(s.surge);
      setPga(s.pga);
      setSpillwayGate(s.spillwayGate);
      setScenarioProgress(p);

      while (
        fired < activeScenario.events.length &&
        activeScenario.events[fired].at <= p
      ) {
        const ev = activeScenario.events[fired];
        pushLog(ev.level, ev.text);
        fired += 1;
      }

      if (p < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        setActiveScenarioId(null);
        setScenarioProgress(0);
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [activeScenario, pushLog]);

  const startScenario = (id: string) => {
    const sc = SCENARIOS.find((s) => s.id === id);
    if (!sc) return;
    setLog(SEED_LOG);
    logId.current = 0;
    setScenarioProgress(0);
    setSelectedSensorId(sc.focusSensorId);
    setActiveScenarioId(id);
    pushLog("info", `Scenario started: ${sc.name} — ${sc.blurb}.`);
  };

  const stopScenario = () => {
    setActiveScenarioId(null);
    setScenarioProgress(0);
    pushLog(
      "info",
      "Scenario aborted by operator. Inputs held at current values.",
    );
  };

  const resetSimulation = () => {
    setActiveScenarioId(null);
    setScenarioProgress(0);
    setSurge(0);
    setPga(0.02);
    setSpillwayGate(100);
  };

  const simLocked = activeScenarioId !== null;

  return (
    <div className="min-h-screen flex flex-col bg-[#0b0f19] text-gray-100 font-sans">
      {/* Top Executive Navigation Bar */}
      <nav className="sticky top-0 z-50 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-6 py-4 bg-[#0b0f19]/90 backdrop-blur-md border-b border-white/10">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-5 shrink-0">
            <div className="flex flex-col items-start justify-center gap-2">
              <Image
                src={SIDARA_LOGO.src}
                alt={SIDARA_LOGO.alt}
                width={SIDARA_LOGO.width}
                height={SIDARA_LOGO.height}
                priority
                unoptimized
                className="h-10 w-auto"
              />
              <Image
                src={SUYAPI_LOGO.src}
                alt={SUYAPI_LOGO.alt}
                width={SUYAPI_LOGO.width}
                height={SUYAPI_LOGO.height}
                priority
                unoptimized
                className="h-8 w-auto"
              />
            </div>
          </div>

          <div className="w-px h-9 bg-white/15 shrink-0" />

          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-[#00e5ff] to-blue-600 flex items-center justify-center shadow-lg shadow-[#00e5ff]/20">
              <Waves className="w-6 h-6 text-black stroke-[2.5]" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight bg-gradient-to-r from-white to-gray-400 bg-clip-text text-transparent">
                Dam Digital Monitoring &amp; Predictive Intelligence
              </h1>
              <p className="text-xs text-gray-400">Powered by ParaOS</p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-4 text-xs">
          <div className="glass-panel px-2.5 py-1.5 rounded-full flex items-center justify-center min-w-[110px]">
            <Image
              src={PARA_LOGO.src}
              alt={PARA_LOGO.alt}
              width={PARA_LOGO.width}
              height={PARA_LOGO.height}
              priority
              unoptimized
              className="h-4 w-auto opacity-90"
            />
          </div>

          <div className="glass-panel px-3.5 py-1.5 rounded-full flex items-center gap-2">
            <span
              className={`w-2.5 h-2.5 rounded-full shadow-md ${
                risk.status === "critical"
                  ? "bg-red-500 shadow-red-500 animate-pulse"
                  : risk.status === "warning"
                    ? "bg-amber-500 shadow-amber-500"
                    : "bg-emerald-500 shadow-emerald-500"
              }`}
            />
            <span>
              Status:{" "}
              <strong className={STATUS_TEXT[risk.status]}>
                {risk.status === "critical"
                  ? "CRITICAL ALERT"
                  : risk.status === "warning"
                    ? "ELEVATED RISK"
                    : "OPERATIONAL"}
              </strong>
            </span>
          </div>

          <div className="glass-panel px-3.5 py-1.5 rounded-full flex items-center gap-2">
            <Radio className="w-3.5 h-3.5 text-[#00e5ff]" />
            <span>
              Nodes:{" "}
              <strong className="text-[#00e5ff] tabular-nums">
                {sensors.length}/{sensors.length} Online
              </strong>
              {alarmCount > 0 && (
                <strong className="text-amber-400 ml-1.5 tabular-nums">
                  · {alarmCount} in alarm
                </strong>
              )}
            </span>
          </div>

          <div className="glass-panel px-3.5 py-1.5 rounded-full flex items-center gap-2">
            <Building2 className="w-3.5 h-3.5 text-purple-400" />
            <span>
              Facility: <strong>{FACILITY_NAME}</strong>
            </span>
          </div>
        </div>
      </nav>

      {/* Investor ROI Banner */}
      <div className="px-6 pt-5">
        <div className="glass-panel p-5 bg-gradient-to-r from-[#00e5ff]/10 via-purple-500/10 to-transparent border-[#00e5ff]/30 flex flex-wrap items-center justify-between gap-4">
          <div>
            <span className="text-xs font-semibold uppercase tracking-wider text-[#00e5ff] flex items-center gap-1.5">
              <Zap className="w-3.5 h-3.5" /> Investor &amp; Executive Pitch
              Metrics
            </span>
            <h2 className="text-base font-bold text-white mt-1">
              Digital Twin Safety Management &amp; Predictive ROI
            </h2>
            <p className="text-xs text-gray-400 mt-0.5">
              Real-time telemetry, 3D structural twin, &amp; physics-AI risk
              predictions benchmarked against ICOLD safety guidelines.
            </p>
          </div>

          <div className="flex items-center gap-8">
            {[
              { v: "-85%", l: "Failure Risk", c: "text-[#00e5ff]" },
              { v: "+22 Yrs", l: "Asset Lifespan", c: "text-purple-400" },
              { v: "$1.4M/yr", l: "OPEX Savings", c: "text-emerald-400" },
              { v: "< 15s", l: "Early Warning", c: "text-amber-400" },
            ].map((m) => (
              <div key={m.l} className="text-center">
                <div
                  className={`text-xl font-extrabold font-mono tabular-nums ${m.c}`}
                >
                  {m.v}
                </div>
                <div className="text-[11px] text-gray-400">{m.l}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Main Dashboard Grid */}
      <main className="grid grid-cols-1 lg:grid-cols-12 gap-5 p-6 flex-1">
        {/* Left Panel: Telemetry, Sensors & Event Log */}
        <section className="lg:col-span-3 flex flex-col gap-5">
          <div className="glass-panel p-4 flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-white/10 pb-3">
              <h2 className="text-sm font-semibold flex items-center gap-2 text-white">
                <Activity className="w-4 h-4 text-[#00e5ff]" /> Live Telemetry
                Overview
              </h2>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-[#00e5ff]/10 text-[#00e5ff] border border-[#00e5ff]/20">
                REAL-TIME
              </span>
            </div>

            {/* KPI cards — status now derives from the reading, not hardcoded. */}
            <div className="grid grid-cols-2 gap-2.5">
              {["WL-01", "P-01", "SF-02", "INC-04"].map((id) => {
                const s = sensors.find((x) => x.id === id)!;
                return (
                  <div
                    key={id}
                    className="bg-white/[0.03] border border-white/10 p-3 rounded-lg flex flex-col gap-1"
                  >
                    <span className="text-[11px] text-gray-400">
                      {s.type === "Water Level Radar"
                        ? "Reservoir Level"
                        : s.type === "Piezometer"
                          ? "Pore Water Press."
                          : s.type === "Seepage Flow Gauge"
                            ? "Seepage Flow"
                            : "Crest Displacement"}
                    </span>
                    <span
                      className={`text-base font-bold font-mono tabular-nums ${STATUS_TEXT[s.status]}`}
                    >
                      {s.value} {s.unit}
                    </span>
                    <div className="h-1 rounded-full bg-white/5 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${
                          s.status === "critical"
                            ? "bg-red-500"
                            : s.status === "warning"
                              ? "bg-amber-500"
                              : "bg-emerald-500"
                        }`}
                        style={{
                          width: `${Math.min(100, s.utilisation * 100)}%`,
                        }}
                      />
                    </div>
                    <span className="text-[10px] text-gray-500 tabular-nums">
                      {s.status === "critical"
                        ? "Limit exceeded"
                        : s.status === "warning"
                          ? "Advisory band"
                          : "In envelope"}{" "}
                      · {s.critAt} {s.unit}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Sensor list */}
            <div className="flex flex-col gap-2 mt-1">
              <h3 className="text-xs font-medium text-gray-400">
                Active Structural Sensors ({sensors.length})
              </h3>
              <div className="space-y-2">
                {sensors.map((sensor) => (
                  <button
                    key={sensor.id}
                    onClick={() => selectSensor(sensor.id)}
                    className={`w-full text-left p-2.5 rounded-lg border transition-all flex items-center justify-between cursor-pointer ${
                      sensor.id === selectedSensorId
                        ? "bg-[#00e5ff]/10 border-[#00e5ff]/50 shadow-md shadow-[#00e5ff]/10"
                        : "bg-white/[0.02] border-white/10 hover:bg-white/[0.05]"
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-white flex items-center gap-1.5">
                        <span
                          className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                            sensor.status === "critical"
                              ? "bg-red-500 animate-pulse"
                              : sensor.status === "warning"
                                ? "bg-amber-500"
                                : "bg-emerald-500"
                          }`}
                        />
                        {sensor.id}
                      </div>
                      <div className="text-[10px] text-gray-400 truncate">
                        {sensor.location}
                      </div>
                    </div>
                    <div className="text-right shrink-0 pl-2">
                      <div
                        className={`text-xs font-mono font-bold tabular-nums ${STATUS_TEXT[sensor.status]}`}
                      >
                        {sensor.value} {sensor.unit}
                      </div>
                      <div className="text-[9px] text-gray-500 tabular-nums">
                        Limit: {sensor.critAt}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Event log */}
          <div className="glass-panel p-4 flex flex-col gap-3 flex-1">
            <div className="flex items-center justify-between border-b border-white/10 pb-3">
              <h2 className="text-sm font-semibold flex items-center gap-2 text-white">
                <ListFilter className="w-4 h-4 text-[#00e5ff]" /> Event &amp;
                Alarm Log
              </h2>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-white/5 text-gray-400 border border-white/10 tabular-nums">
                {log.length}
              </span>
            </div>
            <div className="space-y-2 overflow-y-auto max-h-[300px] custom-scrollbar pr-1">
              {log.map((e) => (
                <div key={e.id} className="flex gap-2 text-[11px] leading-snug">
                  <span
                    className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${LEVEL_STYLES[e.level].dot}`}
                  />
                  <div className="min-w-0">
                    <span className="font-mono text-gray-500 tabular-nums mr-1.5">
                      {e.time}
                    </span>
                    <span className={LEVEL_STYLES[e.level].text}>{e.text}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Center Panel: Scenarios, 3D Twin & Charts */}
        <section className="lg:col-span-6 flex flex-col gap-5">
          {/* Scenario runner */}
          <div className="glass-panel p-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <h2 className="text-sm font-semibold flex items-center gap-2 text-white pl-1">
                <Play className="w-4 h-4 text-[#00e5ff]" /> Scenario Simulation
              </h2>
              <div className="flex items-center gap-2">
                {SCENARIOS.map((sc) => {
                  const Icon = SCENARIO_ICONS[sc.id] ?? Droplets;
                  const isActive = activeScenarioId === sc.id;
                  return (
                    <button
                      key={sc.id}
                      onClick={() => startScenario(sc.id)}
                      disabled={simLocked && !isActive}
                      title={sc.blurb}
                      className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all cursor-pointer border flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed ${
                        isActive
                          ? "bg-[#00e5ff] text-black border-[#00e5ff] shadow-lg shadow-[#00e5ff]/20"
                          : "bg-slate-800/70 text-gray-300 border-white/10 hover:text-white hover:border-white/25"
                      }`}
                    >
                      <Icon className="w-3.5 h-3.5" /> {sc.name}
                    </button>
                  );
                })}
                <button
                  onClick={stopScenario}
                  disabled={!simLocked}
                  className="px-2.5 py-1.5 rounded-md text-xs font-semibold border border-white/10 bg-slate-800/70 text-gray-400 hover:text-white transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
                >
                  <Square className="w-3 h-3" /> Stop
                </button>
              </div>
            </div>

            {activeScenario && (
              <div className="mt-2.5 px-1">
                <div className="flex justify-between text-[10px] text-gray-400 mb-1">
                  <span className="text-[#00e5ff] font-medium">
                    {activeScenario.name} — {activeScenario.blurb}
                  </span>
                  <span className="font-mono tabular-nums">
                    {Math.round(scenarioProgress * 100)}%
                  </span>
                </div>
                <div className="h-1 rounded-full bg-white/10 overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-[#00e5ff] to-blue-500 rounded-full"
                    style={{ width: `${scenarioProgress * 100}%` }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* 3D Canvas Viewport */}
          <div className="glass-panel p-3">
            <div className="flex items-center justify-between px-2 pb-2">
              <h2 className="text-sm font-semibold flex items-center gap-2 text-white">
                <Building2 className="w-4 h-4 text-[#00e5ff]" /> 3D Digital Twin
                Visualizer
              </h2>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                LIVE CANVAS
              </span>
            </div>

            <DamTwinCanvas
              sensors={sensors.map((s) => ({
                id: s.id,
                type: s.type,
                location: s.location,
                value: s.value,
                unit: s.unit,
                status: s.status,
                threshold: s.critAt,
              }))}
              selectedSensorId={selectedSensorId}
              onSelectSensor={selectSensor}
              focusNonce={focusNonce}
              surge={surge}
              pga={pga}
              spillwayGate={spillwayGate}
              riskScore={risk.score}
            />
          </div>

          {/* Charts — the left one follows the selected node. */}
          <div className="glass-panel p-4">
            <div className="flex items-center justify-between pb-3">
              <h2 className="text-sm font-semibold flex items-center gap-2 text-white">
                <TrendingUp className="w-4 h-4 text-[#00e5ff]" /> Sensor Data
                Streams
              </h2>
              <div className="text-[11px] text-gray-400">
                Selected Node:{" "}
                <strong className="text-[#00e5ff]">
                  {selectedSensor.id} ({selectedSensor.type})
                </strong>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div>
                <h4 className="text-xs text-gray-300 mb-1.5 font-medium">
                  {selectedSensor.id} · {selectedSensor.location}
                </h4>
                <TelemetryChart
                  title={selectedSensor.type}
                  dataPoints={histories[selectedSensor.id] ?? []}
                  labels={TIME_LABELS}
                  color="#17a5c9"
                  unit={selectedSensor.unit}
                  thresholds={[
                    {
                      value: selectedSensor.warnAt,
                      label: "Advisory",
                      color: "#f59e0b",
                    },
                    {
                      value: selectedSensor.critAt,
                      label: "Limit",
                      color: "#ef4444",
                    },
                  ]}
                />
              </div>
              <div>
                <h4 className="text-xs text-gray-300 mb-1.5 font-medium">
                  Predicted Risk Score · Physics-AI model
                </h4>
                <TelemetryChart
                  title="Risk Score"
                  dataPoints={riskHistory}
                  labels={TIME_LABELS}
                  color="#8b5cf6"
                  unit="pts"
                  thresholds={[
                    { value: 28, label: "Advisory", color: "#f59e0b" },
                    { value: 60, label: "Critical", color: "#ef4444" },
                  ]}
                />
              </div>
            </div>
          </div>
        </section>

        {/* Right Panel: Risk & Simulator */}
        <section className="lg:col-span-3 glass-panel p-4 flex flex-col gap-4">
          <div className="flex items-center justify-between border-b border-white/10 pb-3">
            <h2 className="text-sm font-semibold flex items-center gap-2 text-white">
              <Sliders className="w-4 h-4 text-purple-400" /> AI What-If
              Simulator
            </h2>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-purple-500/15 text-purple-400 border border-purple-500/30">
              PHYSICS ENGINE
            </span>
          </div>

          <RiskGauge
            score={risk.score}
            drivers={[
              {
                label: "Hydrostatic",
                value: risk.hydrostatic,
                color: "#17a5c9",
              },
              { label: "Seismic", value: risk.seismic, color: "#8b5cf6" },
              { label: "Discharge", value: risk.discharge, color: "#e84a9c" },
            ]}
          />

          {/* Sliders */}
          <div className="space-y-4">
            {[
              {
                label: "Reservoir Surge (Flood Surge)",
                value: surge,
                set: setSurge,
                min: 0,
                max: 15,
                step: 0.5,
                suffix: " m",
                prefix: "+",
                accent: "accent-[#00e5ff]",
                text: "text-[#00e5ff]",
                digits: 1,
              },
              {
                label: "Seismic Ground Accel. (PGA)",
                value: pga,
                set: setPga,
                min: 0,
                max: 0.45,
                step: 0.01,
                suffix: " g",
                prefix: "",
                accent: "accent-purple-400",
                text: "text-purple-400",
                digits: 2,
              },
              {
                label: "Spillway Gate Opening",
                value: spillwayGate,
                set: setSpillwayGate,
                min: 10,
                max: 100,
                step: 5,
                suffix: "%",
                prefix: "",
                accent: "accent-emerald-400",
                text: "text-emerald-400",
                digits: 0,
              },
            ].map((s) => (
              <div key={s.label}>
                <div className="flex justify-between text-xs text-gray-300 mb-1">
                  <span>{s.label}</span>
                  <span className={`font-mono tabular-nums ${s.text}`}>
                    {s.prefix}
                    {s.value.toFixed(s.digits)}
                    {s.suffix}
                  </span>
                </div>
                <input
                  type="range"
                  min={s.min}
                  max={s.max}
                  step={s.step}
                  value={s.value}
                  disabled={simLocked}
                  onChange={(e) => s.set(parseFloat(e.target.value))}
                  className={`w-full ${s.accent} bg-white/10 h-1.5 rounded-lg cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed`}
                />
              </div>
            ))}
            {simLocked && (
              <p className="text-[10px] text-gray-500 -mt-1">
                Inputs are driven by the running scenario. Press Stop to regain
                manual control.
              </p>
            )}
          </div>

          {/* AI protocol */}
          <div
            className={`border rounded-lg p-3 text-xs flex flex-col gap-1.5 transition-colors ${
              protocol.level === "critical"
                ? "bg-red-500/5 border-red-500/30"
                : protocol.level === "warning"
                  ? "bg-amber-500/5 border-amber-500/25"
                  : "bg-white/[0.02] border-white/10"
            }`}
          >
            <span className="font-bold text-[#00e5ff] flex items-center gap-1">
              <ShieldAlert className="w-3.5 h-3.5" /> AI Recommended Protocol:
            </span>
            <p
              className={`leading-relaxed ${
                protocol.level === "critical"
                  ? "text-red-300 font-medium"
                  : protocol.level === "warning"
                    ? "text-amber-200"
                    : "text-gray-400"
              }`}
            >
              {protocol.text}
            </p>
          </div>

          <button
            onClick={resetSimulation}
            className="w-full py-2.5 px-4 rounded-lg bg-gradient-to-r from-[#00e5ff] to-blue-600 text-black font-bold text-xs flex items-center justify-center gap-2 hover:opacity-90 transition-opacity shadow-lg shadow-[#00e5ff]/20 cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" /> Reset Baseline Simulation
          </button>
        </section>
      </main>

      <footer className="mt-auto px-6 py-3 border-t border-white/10 bg-[#0b0f19]/90">
        <p className="text-[11px] text-gray-500">
          {FACILITY_NAME} · demonstration dataset — figures are simulated, not
          live field telemetry.
        </p>
      </footer>
    </div>
  );
}
