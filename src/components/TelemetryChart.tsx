'use client';

import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
  type ScriptableContext,
} from 'chart.js';
import { Line } from 'react-chartjs-2';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler
);

export interface ChartThreshold {
  value: number;
  label: string;
  color: string;
}

interface TelemetryChartProps {
  title: string;
  dataPoints: number[];
  labels: string[];
  color: string;
  unit: string;
  thresholds?: ChartThreshold[];
}

/** #rrggbb -> rgba() so we can build gradients from a single token. */
function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export default function TelemetryChart({
  title,
  dataPoints,
  labels,
  color,
  unit,
  thresholds = [],
}: TelemetryChartProps) {
  const chartData = {
    labels,
    datasets: [
      {
        label: `${title} (${unit})`,
        data: dataPoints,
        borderColor: color,
        borderWidth: 2,
        // Vertical gradient keeps the fill recessive near the axis.
        backgroundColor: (ctx: ScriptableContext<'line'>) => {
          const { chart } = ctx;
          const { ctx: c, chartArea } = chart;
          if (!chartArea) return withAlpha(color, 0.12);
          const g = c.createLinearGradient(0, chartArea.bottom, 0, chartArea.top);
          g.addColorStop(0, withAlpha(color, 0.01));
          g.addColorStop(1, withAlpha(color, 0.3));
          return g;
        },
        tension: 0.35,
        fill: true,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBackgroundColor: color,
        pointHoverBorderColor: '#0b0f19',
        pointHoverBorderWidth: 2,
      },
      // Reference lines are flat datasets so no annotation plugin is needed.
      ...thresholds.map((t) => ({
        label: `${t.label} (${t.value} ${unit})`,
        data: labels.map(() => t.value),
        borderColor: withAlpha(t.color, 0.65),
        borderWidth: 1.5,
        borderDash: [5, 4],
        pointRadius: 0,
        pointHoverRadius: 0,
        fill: false,
        tension: 0,
      })),
    ],
  };

  const thresholdValues = thresholds.map((t) => t.value);
  const dataMax = dataPoints.length ? Math.max(...dataPoints) : 0;
  const dataMin = dataPoints.length ? Math.min(...dataPoints) : 0;
  // Keep the nearest reference line on-canvas without letting a far-off
  // critical limit flatten the live trace.
  const headroom = Math.max(dataMax, ...thresholdValues.filter((v) => v <= dataMax * 1.35));
  const span = Math.max(headroom - dataMin, Math.abs(dataMax) * 0.02, 0.5);

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 350 },
    interaction: { mode: 'index' as const, intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(11, 15, 25, 0.95)',
        titleColor: '#f3f4f6',
        bodyColor: '#d1d5db',
        borderColor: 'rgba(255, 255, 255, 0.12)',
        borderWidth: 1,
        padding: 10,
        displayColors: true,
        boxWidth: 8,
        boxHeight: 8,
        usePointStyle: true,
      },
    },
    scales: {
      x: {
        grid: { color: 'rgba(255, 255, 255, 0.04)' },
        ticks: {
          color: '#6b7280',
          font: { size: 9 },
          maxRotation: 0,
          autoSkip: true,
          maxTicksLimit: 6,
        },
      },
      y: {
        suggestedMin: dataMin - span * 0.25,
        suggestedMax: headroom + span * 0.2,
        grid: { color: 'rgba(255, 255, 255, 0.04)' },
        ticks: { color: '#6b7280', font: { size: 9 }, maxTicksLimit: 5 },
      },
    },
  };

  return (
    <div className="flex flex-col gap-1.5">
      {/* Identity is never color-alone: each series gets a labeled chip. */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="flex items-center gap-1.5 text-[10px] text-gray-400">
          <span className="w-2.5 h-[3px] rounded-full" style={{ background: color }} />
          {title}
        </span>
        {thresholds.map((t) => (
          <span key={t.label} className="flex items-center gap-1.5 text-[10px] text-gray-500">
            <span
              className="w-2.5 h-0 border-t-[1.5px] border-dashed"
              style={{ borderColor: withAlpha(t.color, 0.8) }}
            />
            {t.label} {t.value} {unit}
          </span>
        ))}
      </div>
      <div className="h-[158px] w-full relative">
        <Line data={chartData} options={options} />
      </div>
    </div>
  );
}
