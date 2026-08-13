'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { Box, Layers, Activity } from 'lucide-react';

export interface SensorNode {
  id: string;
  type: string;
  location: string;
  value: number;
  unit: string;
  status: 'normal' | 'warning' | 'critical';
  threshold: number;
}

interface DamTwinCanvasProps {
  sensors: SensorNode[];
  selectedSensorId: string;
  onSelectSensor: (id: string) => void;
  surge: number;
  pga: number;
  spillwayGate: number;
  riskScore: number;
  /** Bumped on user-initiated sensor selection to trigger a camera fly-to. */
  focusNonce: number;
}

// Dynamically import ThreeDamVisualizer to disable SSR for WebGL
const ThreeDamVisualizer = dynamic(() => import('./ThreeDamVisualizer'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-[400px] rounded-xl bg-[#060911] border border-white/10 flex flex-col items-center justify-center gap-3">
      <div className="w-8 h-8 rounded-full border-2 border-[#00e5ff] border-t-transparent animate-spin"></div>
      <span className="text-xs text-gray-400 font-mono">Initializing 3D WebGL Dam Engine...</span>
    </div>
  ),
});

export default function DamTwinCanvas(props: DamTwinCanvasProps) {
  const [viewMode, setViewMode] = useState<'3d' | 'cross' | 'heatmap'>('3d');

  return (
    <div className="relative w-full flex flex-col gap-2">
      {/* Viewport View Controls */}
      <div className="flex justify-between items-center bg-slate-900/60 p-2 rounded-lg border border-white/10 text-xs">
        <span className="text-gray-400 font-medium pl-1">Interactive View Mode:</span>
        <div className="flex gap-2">
          <button
            onClick={() => setViewMode('3d')}
            className={`px-3 py-1.5 rounded-md text-xs font-semibold backdrop-blur-md transition-all cursor-pointer ${
              viewMode === '3d'
                ? 'bg-[#00e5ff] text-black shadow-lg shadow-[#00e5ff]/20'
                : 'bg-slate-800 text-gray-300 hover:text-white border border-white/10'
            }`}
          >
            <Box className="w-3.5 h-3.5 inline mr-1" /> 3D Digital Model
          </button>
          <button
            onClick={() => setViewMode('cross')}
            className={`px-3 py-1.5 rounded-md text-xs font-semibold backdrop-blur-md transition-all cursor-pointer ${
              viewMode === 'cross'
                ? 'bg-[#00e5ff] text-black shadow-lg shadow-[#00e5ff]/20'
                : 'bg-slate-800 text-gray-300 hover:text-white border border-white/10'
            }`}
          >
            <Layers className="w-3.5 h-3.5 inline mr-1" /> Internal Core Cross-Section
          </button>
          <button
            onClick={() => setViewMode('heatmap')}
            className={`px-3 py-1.5 rounded-md text-xs font-semibold backdrop-blur-md transition-all cursor-pointer ${
              viewMode === 'heatmap'
                ? 'bg-[#00e5ff] text-black shadow-lg shadow-[#00e5ff]/20'
                : 'bg-slate-800 text-gray-300 hover:text-white border border-white/10'
            }`}
          >
            <Activity className="w-3.5 h-3.5 inline mr-1" /> Stress Heatmap
          </button>
        </div>
      </div>

      {/* 3D WebGL Canvas */}
      <ThreeDamVisualizer {...props} viewMode={viewMode} />
    </div>
  );
}
