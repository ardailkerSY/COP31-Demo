'use client';

// Radial risk dial + "risk drivers" breakdown.
//
// Status colors (emerald/amber/red) are reserved for the dial's state zones.
// The driver bars use a separate categorical trio validated for CVD
// separation and contrast on this app's dark surface (#121a2b):
//   hydrostatic #17a5c9 · seismic #8b5cf6 · discharge #e84a9c

export interface RiskDriver {
  label: string;
  value: number; // contribution in risk points
  color: string;
}

interface RiskGaugeProps {
  score: number; // 0..100
  drivers: RiskDriver[];
}

const ZONES = [
  { from: 0, to: 28, color: '#10b981' },
  { from: 28, to: 60, color: '#f59e0b' },
  { from: 60, to: 100, color: '#ef4444' },
];

const CX = 110;
const CY = 112;
const R = 86;

// Gauge angle: score 0 → -120°, score 100 → +120° (0° points up).
const toAngle = (score: number) => -120 + (Math.min(100, Math.max(0, score)) / 100) * 240;

function point(angleDeg: number, radius: number): [number, number] {
  const rad = (angleDeg * Math.PI) / 180;
  return [CX + radius * Math.sin(rad), CY - radius * Math.cos(rad)];
}

function arcPath(fromDeg: number, toDeg: number, radius: number): string {
  const [x0, y0] = point(fromDeg, radius);
  const [x1, y1] = point(toDeg, radius);
  const largeArc = toDeg - fromDeg > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${radius} ${radius} 0 ${largeArc} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export default function RiskGauge({ score, drivers }: RiskGaugeProps) {
  const status = score > 60 ? 'critical' : score > 28 ? 'warning' : 'normal';
  const statusColor = status === 'critical' ? '#ef4444' : status === 'warning' ? '#f59e0b' : '#10b981';
  const statusText =
    status === 'critical' ? 'CRITICAL RISK — SEVERE STRESS' : status === 'warning' ? 'ELEVATED RISK — WARNING' : 'LOW RISK — STRUCTURAL STABLE';
  const needleAngle = toAngle(score);

  return (
    <div className="bg-white/[0.03] border border-white/10 rounded-xl p-4 flex flex-col items-center gap-2.5">
      <span className="text-xs text-gray-400 font-medium">PREDICTED STRUCTURAL RISK SCORE</span>

      <svg viewBox="0 0 220 168" className="w-full max-w-[240px]" role="img" aria-label={`Risk score ${score.toFixed(1)} of 100 — ${statusText}`}>
        {/* Zone track (muted), with 2° gaps between zones */}
        {ZONES.map((z) => (
          <path
            key={z.from}
            d={arcPath(toAngle(z.from) + (z.from === 0 ? 0 : 1), toAngle(z.to) - (z.to === 100 ? 0 : 1), R)}
            stroke={z.color}
            strokeOpacity={0.22}
            strokeWidth={10}
            strokeLinecap="round"
            fill="none"
          />
        ))}

        {/* Value arc */}
        {score > 0.5 && (
          <path
            d={arcPath(-120, needleAngle, R)}
            stroke={statusColor}
            strokeWidth={10}
            strokeLinecap="round"
            fill="none"
          />
        )}

        {/* Needle */}
        <g
          style={{
            transform: `rotate(${needleAngle}deg)`,
            transformOrigin: `${CX}px ${CY}px`,
            transition: 'transform 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
          }}
        >
          <line x1={CX} y1={CY - 24} x2={CX} y2={CY - (R - 16)} stroke="#e5e7eb" strokeWidth={2.5} strokeLinecap="round" />
        </g>
        <circle cx={CX} cy={CY} r={4.5} fill="#e5e7eb" />

        {/* Score readout */}
        <text x={CX} y={CY - 38} textAnchor="middle" fontSize="30" fontWeight="800" fontFamily="var(--font-geist-mono), monospace" fill={statusColor}>
          {score.toFixed(1)}
        </text>
        <text x={CX} y={CY - 22} textAnchor="middle" fontSize="9" fill="#6b7280" fontFamily="var(--font-geist-mono), monospace">
          / 100
        </text>

        {/* Zone boundary ticks */}
        {[28, 60].map((s) => {
          const [x0, y0] = point(toAngle(s), R - 9);
          const [x1, y1] = point(toAngle(s), R + 9);
          return <line key={s} x1={x0} y1={y0} x2={x1} y2={y1} stroke="#0b0f19" strokeWidth={2.5} />;
        })}
      </svg>

      <div
        className="text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded -mt-6"
        style={{ background: `${statusColor}26`, color: statusColor }}
      >
        {statusText}
      </div>

      {/* Risk drivers — categorical identity, fixed order */}
      <div className="w-full flex flex-col gap-1.5 pt-1.5 border-t border-white/10">
        <span className="text-[10px] text-gray-500 font-medium uppercase tracking-wide">Risk Drivers (pts)</span>
        {drivers.map((d) => (
          <div key={d.label} className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-[3px] shrink-0" style={{ background: d.color }} />
            <span className="text-[10px] text-gray-400 w-[74px] shrink-0">{d.label}</span>
            <div className="flex-1 h-1.5 bg-white/5 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full"
                style={{ width: `${Math.min(100, (d.value / 65) * 100)}%`, background: d.color, transition: 'width 0.4s ease' }}
              />
            </div>
            <span className="text-[10px] font-mono text-gray-300 w-8 text-right shrink-0">{d.value.toFixed(1)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
