'use client';

import {
  useRef,
  useMemo,
  useState,
  useLayoutEffect,
  useEffect,
  useCallback,
  type ReactNode,
  type RefObject,
} from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import {
  OrbitControls,
  Html,
  Sky,
  Stars,
  Sparkles,
  MeshReflectorMaterial,
} from '@react-three/drei';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { SensorNode } from './DamTwinCanvas';

interface ThreeDamVisualizerProps {
  sensors: SensorNode[];
  selectedSensorId: string;
  onSelectSensor: (id: string) => void;
  surge: number;
  pga: number;
  spillwayGate: number;
  riskScore: number;
  viewMode: '3d' | 'cross' | 'heatmap';
  /**
   * Increments only when a human picks a sensor. Scenario scripts change the
   * selection too, but must not yank the camera off the dam, so the fly-to
   * keys off this counter rather than off `selectedSensorId`.
   */
  focusNonce: number;
}

// ---------------------------------------------------------------------------
// Arch geometry — a single source of truth for both the dam mesh and sensor
// placement, so markers always sit exactly on the structure's surface no
// matter how the profile is tuned.
//
//   theta = thetaFrac * ARC_HALF_SWEEP   (thetaFrac: -1 left abutment … +1 right)
//   x = r * sin(theta), z = r * cos(theta), r = radiusAtHeight(y) + offset
// ---------------------------------------------------------------------------
const ARC_HALF_SWEEP = Math.PI * 0.3;
const BASE_Y = -2.6;
const CREST_Y = 1.55;
const PARAPET_Y = 1.9;
const SPILLWAY_THETA = 0.1;

const PROFILE: [number, number][] = [
  [BASE_Y, 6.4],
  [BASE_Y + 0.7, 6.1],
  [-0.6, 5.7],
  [0.3, 5.3],
  [1.0, 4.98],
  [CREST_Y, 4.82],
  [PARAPET_Y, 4.95],
];

function radiusAtHeight(y: number): number {
  if (y <= PROFILE[0][0]) return PROFILE[0][1];
  for (let i = 0; i < PROFILE.length - 1; i++) {
    const [y0, r0] = PROFILE[i];
    const [y1, r1] = PROFILE[i + 1];
    if (y >= y0 && y <= y1) {
      const t = (y - y0) / (y1 - y0);
      return THREE.MathUtils.lerp(r0, r1, t);
    }
  }
  return PROFILE[PROFILE.length - 1][1];
}

function archPoint(thetaFrac: number, y: number, offset = 0): [number, number, number] {
  const theta = thetaFrac * ARC_HALF_SWEEP;
  const r = radiusAtHeight(y) + offset;
  return [r * Math.sin(theta), y, r * Math.cos(theta)];
}

const SENSOR_LAYOUT: Record<string, { thetaFrac: number; y: number; offset: number }> = {
  'P-01': { thetaFrac: -0.72, y: BASE_Y + 0.55, offset: 0.3 },
  'P-02': { thetaFrac: 0, y: -0.35, offset: -0.08 },
  'P-03': { thetaFrac: 0.5, y: BASE_Y + 0.7, offset: -0.35 },
  'INC-04': { thetaFrac: 0, y: CREST_Y, offset: 0.2 },
  'SF-02': { thetaFrac: 0.3, y: BASE_Y + 1.1, offset: -0.4 },
  'WL-01': { thetaFrac: -1.08, y: 1.1, offset: 1.4 },
};

function sensorPosition(id: string): [number, number, number] {
  const layout = SENSOR_LAYOUT[id] ?? { thetaFrac: 0, y: 0, offset: 0 };
  return archPoint(layout.thetaFrac, layout.y, layout.offset);
}


// ---------------------------------------------------------------------------
// Deterministic seeded PRNG (mulberry32) — used instead of Math.random() so
// procedural layout stays a pure function of its seed during render.
// ---------------------------------------------------------------------------
function seededRandom(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Procedural water-ripple texture (no external assets) used to break up the
// reservoir's mirror reflection with a subtle animated distortion.
// ---------------------------------------------------------------------------
function useRippleTexture() {
  return useMemo(() => {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(size, size);
    const rand = seededRandom(7);
    for (let i = 0; i < size * size; i++) {
      const v = 128 + Math.sin(i * 0.13) * 40 + Math.cos(i * 0.057) * 40 * rand();
      img.data[i * 4] = v;
      img.data[i * 4 + 1] = v;
      img.data[i * 4 + 2] = 255;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(4, 4);
    return tex;
  }, []);
}

// ---------------------------------------------------------------------------
// Terrain — a continuous displaced gorge rather than scattered boulders, so
// the dam reads as keyed into a real canyon. Every prop that sits on the
// ground (rocks, trees, powerhouse) samples the same height field, which is
// what keeps them from floating.
// ---------------------------------------------------------------------------
const GORGE_FLOOR = BASE_Y - 1.0;
/**
 * Wall relief above the gorge floor. Deliberately modest: the rim only needs
 * to sit ~2.5 units above the crest to read as a canyon, and anything taller
 * boxes the orbit camera inside a slot it cannot see out of.
 */
const VALLEY_HEIGHT = 7.6;
const VALLEY_FALLOFF = 1.25;
const TERRAIN_CEILING = 6.5;
/**
 * Flat gorge floor extends to here; canyon walls climb beyond it. Sized so
 * the rock clears the reservoir surface by x≈6.2 even at maximum flood — the
 * abutment blocks only have to plug from the arch end out to that point.
 */
const GORGE_HALF_WIDTH = 4.8;

/** Deterministic rolling variation — pure, so it is safe during render. */
function terrainNoise(x: number, z: number): number {
  return (
    Math.sin(x * 0.45 + 1.3) * Math.cos(z * 0.38 - 0.7) +
    Math.sin(x * 0.97 - 2.1) * Math.cos(z * 0.83 + 1.9) * 0.5 +
    Math.sin(x * 2.1 + 0.4) * Math.cos(z * 1.7 - 1.1) * 0.22
  );
}

export function terrainHeight(x: number, z: number): number {
  const d = Math.abs(x);
  // The gorge is tight at the dam and opens upstream into the reservoir basin.
  const widen = THREE.MathUtils.clamp((z - 3) / 15, 0, 1);
  const halfWidth = GORGE_HALF_WIDTH + widen * 6;
  const over = Math.max(0, d - halfWidth);

  let h = GORGE_FLOOR + VALLEY_HEIGHT * (1 - Math.exp(-over / VALLEY_FALLOFF));
  // Gentle far-field rise closes the basin at both ends without throwing up a
  // wall that would clip the camera.
  h += Math.max(0, z - 26) * 0.35 + Math.max(0, -z - 15) * 0.35;
  // Rugged on the slopes only; the floor stays flat for the structures.
  h += terrainNoise(x, z) * Math.min(0.9, over * 0.35);
  return Math.min(h, TERRAIN_CEILING);
}

function Canyon() {
  const geometry = useMemo(() => {
    const size = 95;
    const segments = 150;
    const geo = new THREE.PlaneGeometry(size, size, segments, segments);
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    // Kept deliberately darker than the concrete so the structure stays the
    // brightest thing in frame — the scene is lit hard enough that lighter
    // rock blows out and swallows the dam.
    const submerged = new THREE.Color('#22303a');
    const bank = new THREE.Color('#46463d');
    const rock = new THREE.Color('#565d68');
    const peak = new THREE.Color('#6b7480');
    const c = new THREE.Color();

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const h = terrainHeight(x, z);
      pos.setY(i, h);

      // Height-banded colouring: silt in the flooded gorge, dry bank at the
      // waterline, then exposed rock climbing to lighter, sunlit ridges.
      if (h < -0.6) c.copy(submerged).lerp(bank, THREE.MathUtils.clamp((h + 3.6) / 3, 0, 1));
      else if (h < 2.4) c.copy(bank).lerp(rock, THREE.MathUtils.clamp((h + 0.6) / 3, 0, 1));
      else c.copy(rock).lerp(peak, THREE.MathUtils.clamp((h - 2.4) / 4, 0, 1));

      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }

    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    return geo;
  }, []);

  return (
    <mesh geometry={geometry} receiveShadow>
      <meshStandardMaterial vertexColors roughness={1} flatShading />
    </mesh>
  );
}

/** Accent boulders, seated on the height field so none of them hover. */
function RockCluster({ side }: { side: 1 | -1 }) {
  const rocks = useMemo(() => {
    const rand = seededRandom(side === 1 ? 101 : 202);
    const arr: { pos: [number, number, number]; scale: [number, number, number]; rot: number; color: string }[] = [];
    const colors = ['#6b7280', '#5b6472', '#7b838f', '#565f6c'];
    for (let i = 0; i < 12; i++) {
      const x = side * (GORGE_HALF_WIDTH + 0.6 + rand() * 9);
      const z = -9 + rand() * 22;
      const s = 0.5 + rand() * 1.3;
      const scale: [number, number, number] = [s * (0.8 + rand() * 0.7), s * (0.7 + rand() * 0.6), s * (0.8 + rand() * 0.7)];
      arr.push({
        pos: [x, terrainHeight(x, z) + scale[1] * 0.35, z],
        scale,
        rot: rand() * Math.PI,
        color: colors[i % colors.length],
      });
    }
    return arr;
  }, [side]);

  return (
    <group>
      {rocks.map((r, i) => (
        <mesh key={i} position={r.pos} rotation={[0.2, r.rot, 0.15]} scale={r.scale} castShadow receiveShadow>
          <dodecahedronGeometry args={[1, 0]} />
          <meshStandardMaterial color={r.color} roughness={0.95} flatShading />
        </mesh>
      ))}
    </group>
  );
}

function Trees({ side }: { side: 1 | -1 }) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const count = 46;

  const transforms = useMemo(() => {
    const rand = seededRandom(side === 1 ? 303 : 404);
    const arr: { pos: [number, number, number]; rotY: number; scale: [number, number, number] }[] = [];
    let guard = 0;
    while (arr.length < count && guard < count * 14) {
      guard += 1;
      const x = side * (GORGE_HALF_WIDTH + 0.3 + rand() * 11);
      const z = -11 + rand() * 26;
      const h = terrainHeight(x, z);
      // Keep them out of the reservoir and off the bare upper ridges.
      if (h < 2.0 || h > 5.6) continue;
      const s = 0.34 + rand() * 0.4;
      arr.push({
        pos: [x, h + s * 0.8, z],
        rotY: rand() * Math.PI,
        scale: [s, s * (0.85 + rand() * 0.7), s],
      });
    }
    return arr;
  }, [side]);

  useLayoutEffect(() => {
    if (!meshRef.current) return;
    const dummy = new THREE.Object3D();
    transforms.forEach((tr, i) => {
      dummy.position.set(...tr.pos);
      dummy.rotation.set(0, tr.rotY, 0);
      dummy.scale.set(...tr.scale);
      dummy.updateMatrix();
      meshRef.current!.setMatrixAt(i, dummy.matrix);
    });
    // Rejected candidates leave unwritten slots; drawing them would stack
    // identity-matrix trees at the world origin.
    meshRef.current.count = transforms.length;
    meshRef.current.instanceMatrix.needsUpdate = true;
  }, [transforms]);

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, count]} castShadow receiveShadow>
      <coneGeometry args={[0.5, 1.8, 6]} />
      <meshStandardMaterial color="#22432f" roughness={1} flatShading />
    </instancedMesh>
  );
}

// ---------------------------------------------------------------------------
// Zoom-aware Html label — scale tracks the OrbitControls dolly range (8–30),
// biggest up close so the readings stay readable, smallest far out so the
// label swarm stops covering the dam. Pure perspective (drei's
// `distanceFactor`) scaling overshoots at both ends, hence the explicit clamp.
// ---------------------------------------------------------------------------
const DOLLY_NEAR = 8;
const DOLLY_FAR = 30;

function ZoomAwareLabel({
  position,
  worldPosition,
  nearScale = 1.3,
  farScale = 0.45,
  children,
}: {
  position: [number, number, number];
  worldPosition?: THREE.Vector3;
  /** Scale at full zoom-in (camera at `DOLLY_NEAR`). */
  nearScale?: number;
  /** Scale at full zoom-out (camera at `DOLLY_FAR`). */
  farScale?: number;
  children: ReactNode;
}) {
  const labelRef = useRef<HTMLDivElement>(null);
  const lastScale = useRef(-1);
  const fallbackWorldPos = useMemo(() => new THREE.Vector3(...position), [position]);
  const target = worldPosition ?? fallbackWorldPos;

  useFrame((state) => {
    const el = labelRef.current;
    if (!el) return;
    const dist = state.camera.position.distanceTo(target);
    // smoothstep instead of a raw ratio: labels hold near full size through
    // the close half of the dolly and fall off toward the wide shot.
    const t = THREE.MathUtils.smoothstep(dist, DOLLY_NEAR, DOLLY_FAR);
    const scale = THREE.MathUtils.lerp(nearScale, farScale, t);
    if (Math.abs(scale - lastScale.current) < 0.002) return;
    lastScale.current = scale;
    el.style.transform = `scale(${scale})`;
  });

  return (
    <Html position={position} center occlude={false}>
      <div ref={labelRef} style={{ transformOrigin: 'center' }}>
        {children}
      </div>
    </Html>
  );
}

// ---------------------------------------------------------------------------
// Sensor beacon — glowing marker + expanding radar ring + light beam.
// ---------------------------------------------------------------------------
function SensorBeacon({
  sensor,
  isSelected,
  onSelect,
}: {
  sensor: SensorNode;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const ringRef = useRef<THREE.Mesh>(null);
  const pos = useMemo(() => sensorPosition(sensor.id), [sensor.id]);
  const worldPos = useMemo(() => new THREE.Vector3(...pos), [pos]);

  const nodeColor = sensor.status === 'critical' ? '#ef4444' : sensor.status === 'warning' ? '#d97706' : '#10b981';
  const accent = '#00e5ff';

  useFrame((state) => {
    if (ringRef.current) {
      const t = (state.clock.elapsedTime * 0.6 + (sensor.id.charCodeAt(0) % 5) * 0.2) % 1;
      ringRef.current.scale.setScalar(0.3 + t * 1.6);
      const mat = ringRef.current.material as THREE.MeshBasicMaterial;
      mat.opacity = (1 - t) * (isSelected ? 0.8 : 0.45);
    }
  });

  return (
    <group position={pos}>
      <mesh
        ref={ringRef}
        rotation={[-Math.PI / 2, 0, 0]}
        renderOrder={2}
      >
        <ringGeometry args={[0.22, 0.28, 32]} />
        <meshBasicMaterial
          color={isSelected ? accent : nodeColor}
          transparent
          opacity={0.5}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>

      <mesh onClick={onSelect}>
        <sphereGeometry args={[0.16, 20, 20]} />
        <meshStandardMaterial
          color={isSelected ? accent : nodeColor}
          emissive={isSelected ? accent : nodeColor}
          emissiveIntensity={isSelected ? 2.4 : 1.4}
          toneMapped={false}
        />
      </mesh>

      <mesh position={[0, 0.55, 0]}>
        <cylinderGeometry args={[0.006, 0.05, 1.1, 8, 1, true]} />
        <meshBasicMaterial
          color={isSelected ? accent : nodeColor}
          transparent
          opacity={0.28}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>

      <ZoomAwareLabel position={[0, 0.34, 0]} worldPosition={worldPos}>
        <div
          onClick={onSelect}
          className={`px-2.5 py-1 rounded-md text-[11px] font-mono font-bold whitespace-nowrap cursor-pointer transition-all shadow-lg ${isSelected
            ? 'bg-[#00e5ff] text-black shadow-[#00e5ff]/50 ring-2 ring-white scale-105'
            : 'bg-slate-950/90 text-slate-100 border border-white/15 hover:border-[#00e5ff] hover:text-[#00e5ff]'
            }`}
        >
          {sensor.id}: {sensor.value} {sensor.unit}
        </div>
      </ZoomAwareLabel>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Main dam scene
// ---------------------------------------------------------------------------
function DamScene({
  sensors,
  selectedSensorId,
  onSelectSensor,
  surge,
  pga,
  spillwayGate,
  riskScore,
  viewMode,
}: ThreeDamVisualizerProps) {
  const damRef = useRef<THREE.Group>(null);
  const reservoirRef = useRef<THREE.Mesh>(null);
  const flowRef = useRef<THREE.Mesh>(null);
  const gateRef = useRef<THREE.Mesh>(null);
  const rippleTex = useRippleTexture();
  const rippleTexRef = useRef(rippleTex);

  const surgeT = surge / 15;
  const waterY = 0.15 + surgeT * 1.35;

  // ---- Lathe geometry for the main arch shell -----------------------------
  const shellGeometry = useMemo(() => {
    const pts = PROFILE.map(([y, r]) => new THREE.Vector2(r, y));
    return new THREE.LatheGeometry(pts, 64, -ARC_HALF_SWEEP, ARC_HALF_SWEEP * 2);
  }, []);

  // Vertex-colored stress field for heatmap mode
  const heatGeometry = useMemo(() => {
    const geo = shellGeometry.clone();
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const low = new THREE.Color('#10b981');
    const mid = new THREE.Color('#f59e0b');
    const high = new THREE.Color('#ef4444');
    const riskT = THREE.MathUtils.clamp(riskScore / 100, 0, 1);

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const heightFrac = THREE.MathUtils.clamp((y - BASE_Y) / (CREST_Y - BASE_Y), 0, 1);
      const thetaFrac = Math.abs(Math.atan2(x, z)) / ARC_HALF_SWEEP;
      const abutmentEase = 1 - THREE.MathUtils.clamp(thetaFrac, 0, 1);
      const stress = THREE.MathUtils.clamp(heightFrac * 0.65 + abutmentEase * 0.35, 0, 1) * (0.35 + riskT * 0.9);
      const c = new THREE.Color();
      if (stress < 0.5) c.lerpColors(low, mid, stress * 2);
      else c.lerpColors(mid, high, (stress - 0.5) * 2);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return geo;
  }, [shellGeometry, riskScore]);

  // Vertical contraction joints down the downstream face. Built as very thin
  // lathe slices from the same profile as the shell, so each groove hugs the
  // curved, battered face exactly instead of being a straight box floating
  // off it. Sitting slightly inside the shell radius puts them on the
  // downstream side, where a viewer actually sees them.
  const contractionJoints = useMemo(() => {
    const arr: THREE.BufferGeometry[] = [];
    const n = 16;
    for (let i = 1; i < n; i++) {
      const frac = -1 + (2 * i) / n;
      if (Math.abs(frac - SPILLWAY_THETA) < 0.09) continue;
      const theta = frac * ARC_HALF_SWEEP;
      const pts = PROFILE.filter(([y]) => y <= CREST_Y).map(([y, r]) => new THREE.Vector2(r - 0.07, y));
      arr.push(new THREE.LatheGeometry(pts, 1, theta - 0.009, 0.018));
    }
    return arr;
  }, []);

  // Gravity thrust blocks keying each end of the arch into the canyon wall.
  // The arch alone stops at x≈±3.9 while the rock face only climbs past
  // x≈±6.9, so without these the crest road ends in mid-air over a gap the
  // reservoir would simply flow around. Each block continues the arc's
  // tangent outward and runs full depth to the gorge floor.
  const thrustBlocks = useMemo(() => {
    const height = CREST_Y - GORGE_FLOOR;
    const depth = 2.3;
    return ([1, -1] as const).map((side) => {
      const end = archPoint(side, CREST_Y, 0);
      // Span from just inside the arch end out to where rock clears the
      // flood surface, so the reservoir cannot slip around the abutment.
      const innerX = Math.abs(end[0]) - 0.4;
      const outerX = 6.5;
      const length = outerX - innerX;
      return {
        side,
        position: [side * (innerX + length / 2), CREST_Y - height / 2, end[2]] as [number, number, number],
        args: [length, height, depth] as [number, number, number],
      };
    });
  }, []);

  const crestPoint = useMemo(() => archPoint(SPILLWAY_THETA, CREST_Y, 0), []);

  // Spillway chute — a box/plane spanning from the gate base down to the
  // plunge pool. Orientation is derived from the actual top/bottom points
  // (rotation about X to align the box's local +Z with that segment) so the
  // ramp always visually connects the crest to the pool instead of floating
  // at a hand-tuned angle that drifts out of alignment.
  const spillwayChute = useMemo(() => {
    const top = archPoint(SPILLWAY_THETA, CREST_Y - 0.2, -0.3);
    const bottom: [number, number, number] = [top[0], BASE_Y - 0.3, 0.4];
    const dy = bottom[1] - top[1];
    const dz = bottom[2] - top[2];
    const length = Math.hypot(dy, dz);
    const angle = Math.atan2(-dy, dz);
    const mid: [number, number, number] = [
      (top[0] + bottom[0]) / 2,
      (top[1] + bottom[1]) / 2,
      (top[2] + bottom[2]) / 2,
    ];
    // Upward surface normal of the ramp, used to float the water film just
    // clear of the deck. World +Y is wrong here — the ramp is steeply raked.
    const normal: [number, number, number] = [0, -dz / length, dy / length];
    const surface = (offset: number): [number, number, number] => [
      mid[0] + normal[0] * offset,
      mid[1] + normal[1] * offset,
      mid[2] + normal[2] * offset,
    ];
    return { top, bottom, length, angle, mid, normal, surface };
  }, []);

  // Reservoir surface. A rectangle cannot bound an arch: its straight near
  // edge cuts across the curve, leaving dry wedges at both abutments where
  // the arch pulls back downstream. The downstream boundary therefore traces
  // the dam's own upstream face, then runs out to the canyon walls.
  const reservoirGeometry = useMemo(() => {
    const halfWidth = 17;
    const farZ = 37;
    const flankZ = 2.5;
    // ShapeGeometry is authored in XY; after rotateX(-90°) a shape point
    // (sx, sy) lands at world (sx, 0, -sy), so world Z is negated here.
    const toShape = (x: number, z: number) => new THREE.Vector2(x, -z);

    const pts: THREE.Vector2[] = [toShape(-halfWidth, flankZ)];
    const segments = 60;
    for (let i = 0; i <= segments; i++) {
      const u = -1 + (2 * i) / segments;
      const p = archPoint(u, CREST_Y, 0.06);
      pts.push(toShape(p[0], p[2]));
    }
    pts.push(toShape(halfWidth, flankZ), toShape(halfWidth, farZ), toShape(-halfWidth, farZ));

    const geo = new THREE.ShapeGeometry(new THREE.Shape(pts));
    geo.rotateX(-Math.PI / 2);

    // ShapeGeometry emits raw positions as UVs; normalise them or the ripple
    // distortion tiles ~70 times across the surface and reads as noise.
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, (uv.getX(i) + halfWidth) / (halfWidth * 2), (uv.getY(i) + farZ) / (farZ + 5));
    }
    uv.needsUpdate = true;
    return geo;
  }, []);

  // Crest road deck
  const crestRoadGeometry = useMemo(() => {
    const rInner = radiusAtHeight(CREST_Y);
    const pts = [
      new THREE.Vector2(rInner - 0.05, CREST_Y - 0.02),
      new THREE.Vector2(rInner + 0.55, CREST_Y - 0.02),
      new THREE.Vector2(rInner + 0.55, CREST_Y + 0.16),
      new THREE.Vector2(rInner - 0.05, CREST_Y + 0.16),
    ];
    return new THREE.LatheGeometry(pts, 64, -ARC_HALF_SWEEP, ARC_HALF_SWEEP * 2);
  }, []);

  // Parapet walls (upstream + downstream lips of the crest)
  const parapetGeometries = useMemo(() => {
    const rInner = radiusAtHeight(CREST_Y);
    return [rInner - 0.1, rInner + 0.5].map((rr) => {
      const pts = [new THREE.Vector2(rr, CREST_Y + 0.15), new THREE.Vector2(rr, PARAPET_Y)];
      return new THREE.LatheGeometry(pts, 48, -ARC_HALF_SWEEP, ARC_HALF_SWEEP * 2);
    });
  }, []);

  // Nested internal zoning shells (revealed through the ghosted shell in cross mode)
  const zoneGeometries = useMemo(() => {
    const scales = [0.86, 0.6, 0.32];
    const segs = [48, 40, 32];
    return scales.map((s, i) => {
      const pts = PROFILE.map(([y, r]) => new THREE.Vector2(r * s, y));
      return new THREE.LatheGeometry(pts, segs[i], -ARC_HALF_SWEEP, ARC_HALF_SWEEP * 2);
    });
  }, []);

  // Crest lamp post positions
  const lampPosts = useMemo(() => {
    const posts: [number, number, number][] = [];
    for (let f = -0.92; f <= 0.92; f += 0.24) {
      if (Math.abs(f - SPILLWAY_THETA) < 0.1) continue;
      posts.push(archPoint(f, CREST_Y, 0.2));
    }
    return posts;
  }, []);

  useFrame((state) => {
    const t = state.clock.elapsedTime;

    if (reservoirRef.current) {
      reservoirRef.current.position.y = THREE.MathUtils.lerp(reservoirRef.current.position.y, waterY, 0.05);
      rippleTexRef.current!.offset.x = t * 0.015;
      rippleTexRef.current!.offset.y = t * 0.011;
    }

    if (flowRef.current) {
      const mat = flowRef.current.material as THREE.MeshStandardMaterial;
      mat.opacity = THREE.MathUtils.lerp(mat.opacity, spillwayGate > 12 ? 0.35 + (spillwayGate / 100) * 0.5 : 0, 0.08);
      mat.emissiveIntensity = 0.4 + Math.sin(t * 6) * 0.15;
    }

    if (gateRef.current) {
      const openFrac = spillwayGate / 100;
      gateRef.current.position.y = THREE.MathUtils.lerp(gateRef.current.position.y, 0.35 + openFrac * 1.1, 0.06);
    }

    if (damRef.current) {
      if (pga > 0.04) {
        const amp = pga * 0.35;
        damRef.current.position.x = Math.sin(t * 32) * amp;
        damRef.current.position.z = Math.cos(t * 32) * amp * 0.6;
      } else {
        damRef.current.position.x = THREE.MathUtils.lerp(damRef.current.position.x, 0, 0.1);
        damRef.current.position.z = THREE.MathUtils.lerp(damRef.current.position.z, 0, 0.1);
      }
    }
  });

  const damColor = '#aab3bf';
  const isCross = viewMode === 'cross';
  const isHeat = viewMode === 'heatmap';
  const mistIntensity = THREE.MathUtils.clamp(spillwayGate / 100, 0, 1);

  return (
    <group>
      {/* ---- Sky / atmosphere ---- */}
      <Sky
        distance={4500}
        sunPosition={[18, 12, 10]}
        turbidity={5}
        rayleigh={3.2}
        mieCoefficient={0.006}
        mieDirectionalG={0.8}
      />
      <Stars radius={90} depth={40} count={2200} factor={2.4} saturation={0} fade speed={0.4} />
      <fog attach="fog" args={['#16223a', 34, 82]} />

      {/* ---- Lighting ---- */}
      <ambientLight intensity={0.7} />
      <hemisphereLight args={['#aecbe8', '#3a4a63', 0.85]} />
      <directionalLight
        position={[16, 18, 10]}
        intensity={3.4}
        color="#ffe0b8"
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-16}
        shadow-camera-right={16}
        shadow-camera-top={16}
        shadow-camera-bottom={-16}
      />
      <directionalLight position={[-16, 10, -14]} intensity={0.85} color="#00e5ff" />
      <pointLight position={[0, 2.6, 5.5]} intensity={1.4} color="#ffd9a8" distance={14} />
      <pointLight position={crestPoint} intensity={pga > 0.15 ? 3 : 0.6} color={pga > 0.15 ? '#ff3b3b' : '#00e5ff'} distance={8} />

      <group ref={damRef}>
        {/* ---- Terrain ---- */}
        <Canyon />
        <RockCluster side={1} />
        <RockCluster side={-1} />
        <Trees side={1} />
        <Trees side={-1} />

        {/* ---- Main arch shell ---- */}
        <mesh
          geometry={isHeat ? heatGeometry : shellGeometry}
          castShadow
          receiveShadow
        >
          <meshStandardMaterial
            color={isHeat ? '#ffffff' : damColor}
            vertexColors={isHeat}
            roughness={0.55}
            metalness={0.08}
            transparent={isCross}
            opacity={isCross ? 0.16 : 1}
            depthWrite={!isCross}
            side={THREE.DoubleSide}
          />
        </mesh>

        {/* ---- Contraction joints on the downstream face ---- */}
        {!isCross &&
          contractionJoints.map((geo, i) => (
            <mesh key={i} geometry={geo}>
              <meshStandardMaterial color="#7a838f" roughness={0.9} side={THREE.DoubleSide} />
            </mesh>
          ))}

        {/* ---- Abutment thrust blocks ---- */}
        {!isCross &&
          thrustBlocks.map((b) => (
            <mesh key={b.side} position={b.position} castShadow receiveShadow>
              <boxGeometry args={b.args} />
              <meshStandardMaterial color="#8b95a1" roughness={0.9} />
            </mesh>
          ))}

        {/* ---- Internal zoning (visible through ghosted shell in cross mode) ---- */}
        {isCross && (
          <>
            <mesh geometry={zoneGeometries[0]}>
              <meshStandardMaterial color="#64748b" roughness={0.9} side={THREE.DoubleSide} />
            </mesh>
            <mesh geometry={zoneGeometries[1]}>
              <meshStandardMaterial color="#94a3b8" roughness={0.9} side={THREE.DoubleSide} />
            </mesh>
            <mesh geometry={zoneGeometries[2]}>
              <meshStandardMaterial color="#d97706" roughness={0.8} side={THREE.DoubleSide} wireframe />
            </mesh>

            <ZoomAwareLabel position={archPoint(0, 0, 0.15)}>
              <div className="px-2 py-0.5 rounded bg-amber-500/90 text-black text-[10px] font-bold whitespace-nowrap">
                Foundation Grout Curtain
              </div>
            </ZoomAwareLabel>
            <ZoomAwareLabel position={archPoint(0.55, -1.0, 0.4)}>
              <div className="px-2 py-0.5 rounded bg-slate-300/90 text-black text-[10px] font-bold whitespace-nowrap">
                Drainage Gallery
              </div>
            </ZoomAwareLabel>
            <ZoomAwareLabel position={archPoint(-0.6, -1.8, 0.75)}>
              <div className="px-2 py-0.5 rounded bg-slate-500/90 text-white text-[10px] font-bold whitespace-nowrap">
                Mass Concrete Monolith
              </div>
            </ZoomAwareLabel>
          </>
        )}

        {/* ---- Crest road + parapet ---- */}
        <mesh geometry={crestRoadGeometry} receiveShadow castShadow>
          <meshStandardMaterial color="#333c48" roughness={0.75} />
        </mesh>

        {/* Parapet walls (up/downstream lips) */}
        {parapetGeometries.map((geo, idx) => (
          <mesh key={idx} geometry={geo}>
            <meshStandardMaterial color="#9aa4b0" roughness={0.7} side={THREE.DoubleSide} />
          </mesh>
        ))}

        {/* Crest lamp posts */}
        {lampPosts.map((p, i) => (
          <group key={i} position={p}>
            <mesh position={[0, 0.35, 0]} castShadow>
              <cylinderGeometry args={[0.02, 0.03, 0.7, 6]} />
              <meshStandardMaterial color="#1a1f27" />
            </mesh>
            <mesh position={[0, 0.72, 0]}>
              <sphereGeometry args={[0.045, 8, 8]} />
              <meshStandardMaterial color="#ffe7b0" emissive="#ffcf7a" emissiveIntensity={2.2} toneMapped={false} />
            </mesh>
          </group>
        ))}

        {/* ---- Intake tower ---- */}
        <group position={archPoint(-1.08, BASE_Y, 1.4)}>
          <mesh position={[0, 2.1, 0]} castShadow receiveShadow>
            <cylinderGeometry args={[0.42, 0.55, (CREST_Y - BASE_Y) + 1.1, 16]} />
            <meshStandardMaterial color="#8f99a6" roughness={0.6} />
          </mesh>
          <mesh position={[0, CREST_Y - BASE_Y + 0.75, 0]} castShadow>
            <cylinderGeometry args={[0.62, 0.62, 0.35, 16]} />
            <meshStandardMaterial color="#4a525f" roughness={0.55} />
          </mesh>
          <mesh position={[0, CREST_Y - BASE_Y + 1.0, 0]}>
            <boxGeometry args={[0.06, 0.5, 0.06]} />
            <meshStandardMaterial color="#1a1f27" />
          </mesh>
          <mesh position={[0, CREST_Y - BASE_Y + 1.28, 0]}>
            <sphereGeometry args={[0.05, 8, 8]} />
            <meshStandardMaterial color="#ff5555" emissive="#ff2222" emissiveIntensity={2.5} toneMapped={false} />
          </mesh>
        </group>

        {/* ---- Spillway structure ---- */}
        <group>
          {/* Piers flanking the gate */}
          {[-0.62, 0.62].map((dx, i) => (
            <mesh
              key={i}
              position={[crestPoint[0] + dx, crestPoint[1] - 0.9, crestPoint[2] - 0.1]}
              rotation={[0, -SPILLWAY_THETA * ARC_HALF_SWEEP, 0]}
              castShadow
              receiveShadow
            >
              <boxGeometry args={[0.3, 2.2, 1.6]} />
              <meshStandardMaterial color="#6b7684" roughness={0.7} />
            </mesh>
          ))}

          {/* Gate leaf (animates with spillwayGate) */}
          <mesh ref={gateRef} position={[crestPoint[0], 0.35, crestPoint[2] - 0.05]}>
            <boxGeometry args={[1.1, 1.3, 0.12]} />
            <meshStandardMaterial color="#94a3b8" metalness={0.6} roughness={0.35} />
          </mesh>

          {/* Chute ramp down to the plunge pool */}
          <mesh
            position={spillwayChute.mid}
            rotation={[spillwayChute.angle, 0, 0]}
            receiveShadow
            castShadow
          >
            <boxGeometry args={[1.5, 0.35, spillwayChute.length]} />
            <meshStandardMaterial color="#707a88" roughness={0.75} />
          </mesh>

          {/* Flowing water sheet on the chute */}
          <mesh
            ref={flowRef}
            position={spillwayChute.surface(0.2)}
            rotation={[spillwayChute.angle, 0, 0]}
          >
            {/* A thin slab, not a plane: PlaneGeometry's long axis is Y while
                the ramp box's is Z, so sharing one X-rotation left the water
                sheet stabbing through the chute at right angles. */}
            <boxGeometry args={[1.3, 0.05, spillwayChute.length - 0.25]} />
            <meshStandardMaterial
              color="#7dd3fc"
              emissive="#38bdf8"
              emissiveIntensity={0.4}
              transparent
              opacity={0}
              roughness={0.15}
              side={THREE.DoubleSide}
            />
          </mesh>

          {/* Plunge-pool mist */}
          <Sparkles
            count={40}
            scale={[2.2, 1.4, 2.2]}
            position={spillwayChute.bottom}
            size={3}
            speed={0.4}
            opacity={mistIntensity * 0.8}
            color="#bae6fd"
          />
        </group>

        {/* ---- Reservoir (reflective, upstream) ---- */}
        <mesh ref={reservoirRef} geometry={reservoirGeometry} position={[0, waterY, 0]}>
          <MeshReflectorMaterial
            mixBlur={6}
            mixStrength={1.1}
            resolution={512}
            blur={[300, 100]}
            mirror={0.4}
            depthScale={0.4}
            minDepthThreshold={0.85}
            maxDepthThreshold={1.2}
            color="#164055"
            metalness={0.25}
            roughness={0.5}
            distortion={0.4}
            distortionMap={rippleTex}
          />
        </mesh>

        {/* ---- Downstream tailrace ---- */}
        <mesh position={[spillwayChute.bottom[0], BASE_Y - 0.85, spillwayChute.bottom[2] - 2.8]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[8, 7]} />
          <meshStandardMaterial color="#144f6b" roughness={0.4} metalness={0.2} transparent opacity={0.85} />
        </mesh>

        {/* ---- Interactive sensor beacons ---- */}
        {sensors.map((sensor) => (
          <SensorBeacon
            key={sensor.id}
            sensor={sensor}
            isSelected={sensor.id === selectedSensorId}
            onSelect={() => onSelectSensor(sensor.id)}
          />
        ))}
      </group>
    </group>
  );
}

// Azimuth is clamped to keep the camera out of the unmodeled backside of the
// canyon, where it ends up grazing along the huge reflective reservoir plane
// and the view whites out. Auto-rotate reverses direction at these bounds
// (see AutoOrbitPingPong) instead of drifting into the clamp and freezing.
const AZIMUTH_MIN = -0.55;
const AZIMUTH_MAX = 2.1;

/**
 * Flies the camera to frame a sensor whenever the selection changes.
 *
 * The current view direction is preserved and only the orbit target and dolly
 * distance are re-framed, so the move never swings through a clamped azimuth
 * or dives under the water plane. The first selection is skipped so the scene
 * opens on its wide establishing shot.
 */
function CameraFocusRig({
  controlsRef,
  selectedSensorId,
  focusNonce,
  onFocusStart,
}: {
  controlsRef: RefObject<OrbitControlsImpl | null>;
  selectedSensorId: string;
  focusNonce: number;
  onFocusStart: () => void;
}) {
  const camera = useThree((s) => s.camera);
  const desiredTarget = useRef(new THREE.Vector3());
  const desiredPos = useRef(new THREE.Vector3());
  const animating = useRef(false);
  const sensorIdRef = useRef(selectedSensorId);

  useEffect(() => {
    sensorIdRef.current = selectedSensorId;
  }, [selectedSensorId]);

  useEffect(() => {
    // nonce 0 is the initial render — keep the wide establishing shot.
    if (focusNonce === 0) return;
    const controls = controlsRef.current;
    if (!controls) return;

    // Frame the sensor midway between it and the dam centre so the structure
    // stays in shot instead of the camera burying itself in one instrument.
    const sensor = new THREE.Vector3(...sensorPosition(sensorIdRef.current));
    const target = sensor.clone().lerp(new THREE.Vector3(0, -0.3, 2), 0.35);

    const dir = new THREE.Vector3().subVectors(camera.position, controls.target);
    if (dir.lengthSq() < 1e-6) dir.set(0.6, 0.4, 1);
    dir.normalize();

    desiredTarget.current.copy(target);
    desiredPos.current.copy(target).addScaledVector(dir, 13);
    animating.current = true;
    onFocusStart();
  }, [focusNonce, camera, controlsRef, onFocusStart]);

  useFrame(() => {
    if (!animating.current) return;
    const controls = controlsRef.current;
    if (!controls) return;

    controls.target.lerp(desiredTarget.current, 0.09);
    camera.position.lerp(desiredPos.current, 0.09);
    controls.update();

    if (camera.position.distanceTo(desiredPos.current) < 0.06) animating.current = false;
  });

  return null;
}

function AutoOrbitPingPong({
  controlsRef,
  enabled,
}: {
  controlsRef: RefObject<OrbitControlsImpl | null>;
  enabled: boolean;
}) {
  // Note: positive autoRotateSpeed *decreases* OrbitControls' azimuthal
  // angle (confirmed empirically), so the sign assignments below are
  // intentionally the reverse of what "increases/decreases" might suggest.
  const dirRef = useRef(1);
  useFrame(() => {
    const controls = controlsRef.current;
    if (!controls || !enabled) return;
    const az = controls.getAzimuthalAngle();
    if (az >= AZIMUTH_MAX - 0.01) dirRef.current = 1;
    else if (az <= AZIMUTH_MIN + 0.01) dirRef.current = -1;
    controls.autoRotateSpeed = 0.55 * dirRef.current;
  });
  return null;
}

export default function ThreeDamVisualizer(props: ThreeDamVisualizerProps) {
  const [autoRotate, setAutoRotate] = useState(true);
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const stopAutoRotate = useCallback(() => setAutoRotate(false), []);

  return (
    <div className="w-full h-[440px] rounded-xl overflow-hidden bg-[#080c14] border border-white/10 shadow-inner relative">
      <Canvas
        camera={{ position: [12, 15, 15], fov: 42 }}
        shadows
        gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.4 }}
        onPointerDown={() => setAutoRotate(false)}
      >
        <color attach="background" args={['#080c14']} />
        <DamScene {...props} />
        <OrbitControls
          ref={controlsRef}
          enablePan={false}
          enableZoom={true}
          enableRotate={true}
          autoRotate={autoRotate}
          autoRotateSpeed={0.55}
          minDistance={8}
          maxDistance={30}
          minPolarAngle={0.3}
          // Hold the camera above the canyon rim; grazing angles put the eye
          // inside the terrain now that the gorge has real walls.
          maxPolarAngle={Math.PI / 2 - 0.6}
          minAzimuthAngle={AZIMUTH_MIN}
          maxAzimuthAngle={AZIMUTH_MAX}
          target={[0, -0.3, 2]}
          dampingFactor={0.08}
        />
        <AutoOrbitPingPong controlsRef={controlsRef} enabled={autoRotate} />
        <CameraFocusRig
          controlsRef={controlsRef}
          selectedSensorId={props.selectedSensorId}
          focusNonce={props.focusNonce}
          onFocusStart={stopAutoRotate}
        />
      </Canvas>

      {/* CSS vignette — kept off the WebGL post-processing stack, which is
          unreliable across GPU/driver combinations in this Next.js version. */}
      <div
        className="absolute inset-0 pointer-events-none rounded-xl"
        style={{ boxShadow: 'inset 0 0 90px rgba(0,0,0,0.35)' }}
      />

      {/* Overlay chrome */}
      <div className="absolute top-3 left-3 bg-slate-950/80 backdrop-blur-md px-3 py-1.5 rounded-lg border border-white/10 text-[11px] text-slate-200 font-medium shadow-sm pointer-events-none flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-[#00e5ff] animate-pulse"></span>
        <span>360° Digital Twin · Live WebGL Render</span>
      </div>

      <button
        onClick={() => setAutoRotate((v) => !v)}
        className={`absolute top-3 right-3 px-2.5 py-1.5 rounded-lg border text-[10px] font-mono font-semibold backdrop-blur-md transition-all cursor-pointer ${autoRotate
          ? 'bg-[#00e5ff]/15 border-[#00e5ff]/40 text-[#00e5ff]'
          : 'bg-slate-950/80 border-white/10 text-gray-400 hover:text-white'
          }`}
      >
        {autoRotate ? '⏸ Auto-Orbit' : '▶ Auto-Orbit'}
      </button>

      <div className="absolute bottom-3 left-3 bg-slate-950/80 backdrop-blur-md px-3 py-1.5 rounded-lg border border-white/10 text-[10px] text-gray-400 font-mono pointer-events-none">
        Drag to orbit · Scroll to zoom
      </div>
    </div>
  );
}
