// Domain model for the digital twin: sensor definitions, the response
// functions that map simulator inputs onto sensor readings, the risk
// decomposition, and the scripted demo scenarios.
//
// Everything here is a pure function of (surge, pga, spillwayGate) so the
// dashboard can derive state during render instead of syncing it through
// effects.

export type SensorStatus = 'normal' | 'warning' | 'critical';

export interface SensorMeta {
  id: string;
  type: string;
  location: string;
  unit: string;
  /** Reading at rest (surge 0, pga 0, gate 100%). */
  base: number;
  /** Sensitivity to reservoir surge (unit per metre). */
  kSurge: number;
  /** Sensitivity to peak ground acceleration (unit per g). */
  kPga: number;
  /** Sensitivity to reduced discharge capacity (unit per % gate closure). */
  kGate: number;
  warnAt: number;
  critAt: number;
  decimals: number;
}

// Concrete double-curvature arch dam. Instrument names and elevations follow
// arch-dam practice (heel/toe, foundation gallery, pendulum) rather than the
// embankment terminology used for earth-fill structures.
export const SENSOR_META: SensorMeta[] = [
  {
    id: 'P-01',
    type: 'Piezometer',
    location: 'Upstream Heel (EL 490 m)',
    unit: 'kPa',
    base: 242.4,
    kSurge: 8.5,
    kPga: 150,
    kGate: 0.15,
    warnAt: 270,
    critAt: 300,
    decimals: 1,
  },
  {
    id: 'P-02',
    type: 'Piezometer',
    location: 'Foundation Gallery (EL 510 m)',
    unit: 'kPa',
    base: 185.1,
    kSurge: 5.2,
    kPga: 90,
    kGate: 0.1,
    warnAt: 205,
    critAt: 220,
    decimals: 1,
  },
  {
    id: 'P-03',
    type: 'Piezometer',
    location: 'Downstream Toe (EL 480 m)',
    unit: 'kPa',
    base: 92.6,
    kSurge: 2.4,
    kPga: 60,
    kGate: 0.08,
    warnAt: 130,
    critAt: 150,
    decimals: 1,
  },
  {
    id: 'INC-04',
    type: 'Pendulum / Inclinometer',
    location: 'Crest Centre (Block 04)',
    unit: 'mm',
    base: 3.2,
    kSurge: 0.4,
    kPga: 25,
    kGate: 0,
    warnAt: 6.5,
    critAt: 8.0,
    decimals: 1,
  },
  {
    id: 'SF-02',
    type: 'Seepage Flow Gauge',
    location: 'Drainage Gallery G-02',
    unit: 'L/min',
    base: 14.2,
    kSurge: 1.8,
    kPga: 30,
    kGate: 0,
    warnAt: 20,
    critAt: 25,
    decimals: 1,
  },
  {
    id: 'WL-01',
    type: 'Water Level Radar',
    location: 'Reservoir Intake Tower',
    unit: 'm',
    base: 537.4,
    kSurge: 1,
    kPga: 0,
    kGate: 0.02,
    warnAt: 543,
    critAt: 546,
    decimals: 1,
  },
];

export interface SensorReading extends SensorMeta {
  value: number;
  status: SensorStatus;
  /** 0..1 fraction of the critical limit — drives bar fills. */
  utilisation: number;
}

export interface SimInputs {
  surge: number;
  pga: number;
  spillwayGate: number;
}

export function readSensors({ surge, pga, spillwayGate }: SimInputs): SensorReading[] {
  const closure = 100 - spillwayGate;
  return SENSOR_META.map((m) => {
    const raw = m.base + surge * m.kSurge + pga * m.kPga + closure * m.kGate;
    const value = parseFloat(raw.toFixed(m.decimals));
    const status: SensorStatus = value >= m.critAt ? 'critical' : value >= m.warnAt ? 'warning' : 'normal';
    return { ...m, value, status, utilisation: Math.min(1.4, value / m.critAt) };
  });
}

// ---------------------------------------------------------------------------
// Risk decomposition — the score is the sum of named contributions so the
// gauge can explain *why* it moved, not just that it did.
// ---------------------------------------------------------------------------
export const RISK_BASELINE = 12;

export interface RiskBreakdown {
  score: number;
  hydrostatic: number;
  seismic: number;
  discharge: number;
  status: SensorStatus;
  label: string;
}

export function computeRisk({ surge, pga, spillwayGate }: SimInputs): RiskBreakdown {
  const hydrostatic = surge * 3.8;
  const seismic = pga * 140;
  const discharge = (100 - spillwayGate) * 0.35;
  const score = Math.min(100, Math.max(5, hydrostatic + seismic + discharge + RISK_BASELINE));
  const status: SensorStatus = score > 60 ? 'critical' : score > 28 ? 'warning' : 'normal';
  return {
    score,
    hydrostatic,
    seismic,
    discharge,
    status,
    label:
      status === 'critical'
        ? 'CRITICAL RISK — SEVERE STRESS'
        : status === 'warning'
        ? 'ELEVATED RISK — WARNING'
        : 'LOW RISK — STRUCTURALLY STABLE',
  };
}

export function recommendedProtocol(risk: RiskBreakdown): { level: SensorStatus; text: string } {
  if (risk.status === 'critical') {
    return {
      level: 'critical',
      text: 'EMERGENCY PROTOCOL: Open spillway gates to 100%. Dispatch structural team to inspect the downstream toe (P-03) and drainage gallery. Notify downstream settlements per Emergency Action Plan.',
    };
  }
  if (risk.status === 'warning') {
    return {
      level: 'warning',
      text: 'ADVISORY: Hydrodynamic pressure elevated. Increase piezometric sampling to 1 s intervals, verify gallery drain flow at SF-02, and stage auxiliary spillway gates for release.',
    };
  }
  return {
    level: 'normal',
    text: 'Structure stable under nominal hydrodynamic loads. No intervention required. Piezometric heads and crest deflection within design safety envelopes.',
  };
}

// ---------------------------------------------------------------------------
// Scripted scenarios — keyframes are interpolated over the run so the sliders,
// the 3D twin, the charts and the risk gauge all animate from one clock.
// ---------------------------------------------------------------------------
export type EventLevel = 'info' | 'warning' | 'critical' | 'success';

interface Keyframe extends SimInputs {
  /** Progress 0..1 at which this pose is reached. */
  at: number;
}

interface ScenarioEvent {
  at: number;
  level: EventLevel;
  text: string;
}

export interface Scenario {
  id: string;
  name: string;
  blurb: string;
  durationMs: number;
  keys: Keyframe[];
  events: ScenarioEvent[];
  /** Sensor the camera should frame while this scenario runs. */
  focusSensorId: string;
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'flood',
    name: 'Flood Event',
    blurb: '1-in-500-year inflow, staged gate response',
    durationMs: 26000,
    focusSensorId: 'WL-01',
    keys: [
      { at: 0.0, surge: 0, pga: 0.02, spillwayGate: 100 },
      { at: 0.18, surge: 4.5, pga: 0.02, spillwayGate: 100 },
      { at: 0.4, surge: 9.5, pga: 0.03, spillwayGate: 75 },
      { at: 0.58, surge: 13.5, pga: 0.03, spillwayGate: 45 },
      { at: 0.74, surge: 15, pga: 0.03, spillwayGate: 30 },
      { at: 0.88, surge: 11, pga: 0.02, spillwayGate: 100 },
      { at: 1.0, surge: 6, pga: 0.02, spillwayGate: 100 },
    ],
    events: [
      { at: 0.02, level: 'info', text: 'Upstream catchment radar: extreme precipitation cell inbound.' },
      { at: 0.2, level: 'info', text: 'WL-01 reservoir level rising 0.9 m/h — inflow exceeds outflow.' },
      { at: 0.36, level: 'warning', text: 'P-01 pore pressure crossed advisory limit (270 kPa).' },
      { at: 0.5, level: 'warning', text: 'Gate capacity saturating — discharge headroom below 50%.' },
      { at: 0.62, level: 'critical', text: 'SF-02 seepage above 25 L/min. Emergency Action Plan armed.' },
      { at: 0.76, level: 'info', text: 'Auxiliary spillway released — all gates commanded to 100%.' },
      { at: 0.9, level: 'success', text: 'Reservoir drawdown confirmed. Risk trending to advisory.' },
      { at: 0.99, level: 'success', text: 'Event closed. Structure held within design envelope.' },
    ],
  },
  {
    id: 'seismic',
    name: 'Seismic Event',
    blurb: 'M6.4 near-field rupture, aftershock sequence',
    durationMs: 22000,
    focusSensorId: 'INC-04',
    keys: [
      { at: 0.0, surge: 2, pga: 0.02, spillwayGate: 100 },
      { at: 0.12, surge: 2, pga: 0.38, spillwayGate: 100 },
      { at: 0.26, surge: 2.4, pga: 0.14, spillwayGate: 100 },
      { at: 0.42, surge: 2.6, pga: 0.29, spillwayGate: 90 },
      { at: 0.6, surge: 2.8, pga: 0.09, spillwayGate: 80 },
      { at: 0.8, surge: 3, pga: 0.05, spillwayGate: 100 },
      { at: 1.0, surge: 3, pga: 0.02, spillwayGate: 100 },
    ],
    events: [
      { at: 0.03, level: 'info', text: 'Regional seismic network: P-wave detected, 14 s to arrival.' },
      { at: 0.13, level: 'critical', text: 'Main shock — 0.38 g peak ground acceleration recorded at abutment.' },
      { at: 0.2, level: 'critical', text: 'INC-04 crest deflection exceeded 8.0 mm design limit.' },
      { at: 0.34, level: 'warning', text: 'Automated post-event integrity sweep started across 6 nodes.' },
      { at: 0.44, level: 'critical', text: 'Aftershock 0.29 g — secondary deflection peak logged.' },
      { at: 0.66, level: 'warning', text: 'Partial gate throttle to reduce hydrodynamic coupling.' },
      { at: 0.85, level: 'success', text: 'Deflection recovering elastically — no residual offset detected.' },
      { at: 0.99, level: 'success', text: 'Structural integrity confirmed. Manual inspection scheduled.' },
    ],
  },
  {
    id: 'gate',
    name: 'Gate Malfunction',
    blurb: 'Radial gate seizure during high inflow',
    durationMs: 20000,
    focusSensorId: 'SF-02',
    keys: [
      { at: 0.0, surge: 5, pga: 0.02, spillwayGate: 100 },
      { at: 0.16, surge: 6, pga: 0.02, spillwayGate: 55 },
      { at: 0.32, surge: 7.5, pga: 0.02, spillwayGate: 15 },
      { at: 0.55, surge: 11, pga: 0.02, spillwayGate: 10 },
      { at: 0.72, surge: 12.5, pga: 0.02, spillwayGate: 10 },
      { at: 0.88, surge: 9, pga: 0.02, spillwayGate: 70 },
      { at: 1.0, surge: 6.5, pga: 0.02, spillwayGate: 100 },
    ],
    events: [
      { at: 0.04, level: 'warning', text: 'Gate 2 hoist current anomaly — actuator response degraded.' },
      { at: 0.18, level: 'critical', text: 'Radial gate seized at 15% opening. Discharge capacity lost.' },
      { at: 0.36, level: 'warning', text: 'Reservoir accumulating — level rising with no relief path.' },
      { at: 0.5, level: 'critical', text: 'Risk score entered critical band. Maintenance crew dispatched.' },
      { at: 0.7, level: 'warning', text: 'Manual override engaged at gantry — hydraulic bypass priming.' },
      { at: 0.86, level: 'success', text: 'Gate freed. Controlled release restored to 70%.' },
      { at: 0.99, level: 'success', text: 'Discharge nominal. Post-incident report queued for review.' },
    ],
  },
];

/** Interpolate the simulator inputs at progress `p` (0..1). */
export function sampleScenario(scenario: Scenario, p: number): SimInputs {
  const keys = scenario.keys;
  if (p <= keys[0].at) return pick(keys[0]);
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (p >= a.at && p <= b.at) {
      const span = b.at - a.at || 1;
      const raw = (p - a.at) / span;
      // Smoothstep keeps slider motion organic instead of mechanical.
      const t = raw * raw * (3 - 2 * raw);
      return {
        surge: a.surge + (b.surge - a.surge) * t,
        pga: a.pga + (b.pga - a.pga) * t,
        spillwayGate: a.spillwayGate + (b.spillwayGate - a.spillwayGate) * t,
      };
    }
  }
  return pick(keys[keys.length - 1]);
}

function pick({ surge, pga, spillwayGate }: Keyframe): SimInputs {
  return { surge, pga, spillwayGate };
}
