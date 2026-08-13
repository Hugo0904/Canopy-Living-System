import { Html, OrbitControls, Sparkles } from "@react-three/drei";
import { Canvas, events as createPointerEvents, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject, type SyntheticEvent } from "react";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { cardDisplayName, moduleName, structureDisplayName, t, type Locale } from "../i18n";
import { buildZonePositions, stableIdHash, type ZonePosition, type ZonePositionMap } from "../topologyLayout";
import type { CanopyConnection, CanopyStructure, HealthStatus, ModuleHealth, SeedCard, StructureNode } from "../types";

const STATUS_COLORS: Record<HealthStatus, string> = {
  healthy: "#58d68d",
  attention: "#f6c453",
  critical: "#ff6b6b",
  unknown: "#91a7a0",
};

const INTERACTION_PRIORITY = {
  shell: 0,
  landmark: 20,
  foreground: 100,
} as const;

const MAX_CLICK_TRAVEL_PX = 4;
const LABORATORY_OFFSET = 3.15;
const MAX_CAMERA_PAN_RADIUS = 14;

type CameraPanDirection = -1 | 1;

interface CameraPanCommand {
  direction: CameraPanDirection;
  revision: number;
}

export interface VisualEffects {
  master: boolean;
  particles: boolean;
  flow: boolean;
  clouds: boolean;
  glow: boolean;
  motion: boolean;
  fura: boolean;
}

export type EffectDistance = "near" | "far";

type ActiveVisualEffects = Pick<VisualEffects, "particles" | "flow" | "clouds" | "glow" | "motion">;

function interactionPriority(object: THREE.Object3D): number {
  let current: THREE.Object3D | null = object;
  while (current) {
    const priority = current.userData.interactionPriority;
    if (typeof priority === "number") return priority;
    current = current.parent;
  }
  return 0;
}

function prioritizeIntersections(intersections: THREE.Intersection[]): THREE.Intersection[] {
  return [...intersections].sort((left, right) => (
    interactionPriority(right.object) - interactionPriority(left.object)
    || left.distance - right.distance
  ));
}

function selectFromPointer(event: ThreeEvent<MouseEvent>, onSelect: () => void) {
  event.stopPropagation();
  if (event.delta <= MAX_CLICK_TRAVEL_PX) onSelect();
}

// Drei's <Html> overlays live inside the same event container as the WebGL
// canvas. Without stopping the DOM event here, one click can select the label
// and then continue into the raycaster, where the shell behind that label may
// overwrite the foreground selection. Keep every projected label on the same
// interaction path as its visible 3D object.
function stopProjectedLabelEvent(event: SyntheticEvent) {
  event.stopPropagation();
}

function selectFromProjectedLabel(event: SyntheticEvent, onSelect: () => void) {
  event.stopPropagation();
  onSelect();
}

interface SceneProps {
  modules: ModuleHealth[];
  connections: CanopyConnection[];
  cards: SeedCard[];
  structure?: CanopyStructure;
  locale: Locale;
  backgroundMode: "detailed" | "simple" | "none";
  visualEffects: VisualEffects;
  view: "overview" | "seed" | "structure" | "laboratory";
  selectedModuleId: string;
  selectedCardId: string;
  selectedStructureId: string;
  focusRevision: number;
  activeModuleIds: string[];
  growthProgress: number;
  growthEvidence: number;
  onSelectModule: (moduleId: string) => void;
  onSelectCard: (cardId: string) => void;
  onSelectStructure: (nodeId: string) => void;
  onSelectLaboratory: () => void;
  onSceneInteraction: () => void;
  onEffectDistanceChange: (distance: EffectDistance) => void;
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

// Slow ambient movement does not need display-refresh-rate rendering. Keeping
// it near 10 fps avoids repainting the entire detailed world for every mote.
// OrbitControls and focus transitions still invalidate independently while the
// user is moving the camera, so interaction remains responsive.
const IDLE_FRAME_INTERVAL_MS = 1000 / 10;

function SceneRenderBudget({ shadowRevision, active }: { shadowRevision: string; active: boolean }) {
  const gl = useThree((state) => state.gl);
  const invalidate = useThree((state) => state.invalidate);

  useEffect(() => {
    if (!active) {
      invalidate();
      return undefined;
    }
    let interval: number | undefined;
    const stop = () => {
      if (interval === undefined) return;
      window.clearInterval(interval);
      interval = undefined;
    };
    const start = () => {
      stop();
      if (document.hidden) return;
      invalidate();
      interval = window.setInterval(invalidate, IDLE_FRAME_INTERVAL_MS);
    };
    const syncVisibility = () => {
      if (document.hidden) stop();
      else start();
    };
    start();
    document.addEventListener("visibilitychange", syncVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", syncVisibility);
    };
  }, [active, invalidate]);

  useEffect(() => {
    const previousAutoUpdate = gl.shadowMap.autoUpdate;
    gl.shadowMap.autoUpdate = false;
    gl.shadowMap.needsUpdate = true;
    invalidate();
    return () => {
      gl.shadowMap.autoUpdate = previousAutoUpdate;
      gl.shadowMap.needsUpdate = true;
    };
  }, [gl, invalidate]);

  useEffect(() => {
    gl.shadowMap.needsUpdate = true;
    invalidate();
    const settledShadow = window.setTimeout(() => {
      gl.shadowMap.needsUpdate = true;
      invalidate();
    }, 480);
    return () => window.clearTimeout(settledShadow);
  }, [gl, invalidate, shadowRevision]);

  return null;
}

function CameraRig({
  view,
  selectedModuleId,
  focusRevision,
  cameraPanRevision,
  controlsRef,
  zonePositions,
  laboratoryPosition,
}: Pick<SceneProps, "view" | "selectedModuleId" | "focusRevision"> & {
  cameraPanRevision: number;
  controlsRef: RefObject<OrbitControlsImpl | null>;
  zonePositions: ZonePositionMap;
  laboratoryPosition?: ZonePosition;
}) {
  const { camera, invalidate, size } = useThree();
  const destination = useRef(new THREE.Vector3());
  const target = useRef(new THREE.Vector3());
  const animating = useRef(false);

  useEffect(() => {
    const narrow = size.width / Math.max(size.height, 1) < 0.72;
    if (camera instanceof THREE.PerspectiveCamera) {
      const desiredFov = narrow ? 48 : 43;
      if (camera.fov !== desiredFov) {
        camera.fov = desiredFov;
        camera.updateProjectionMatrix();
      }
    }
    if (view === "seed") {
      destination.current.set(-4.5, narrow ? 6.4 : 5.3, narrow ? 18.5 : 11.8);
      target.current.set(-3.8, -0.5, 0.5);
    } else if (view === "structure") {
      destination.current.set(0, narrow ? 7 : 5.4, narrow ? 20 : 12.8);
      target.current.set(0, 1.05, 0);
    } else if (view === "laboratory" && laboratoryPosition) {
      const [x, y, z] = laboratoryPosition;
      target.current.set(x, y + 1.05, z);
      destination.current.set(x, y + (narrow ? 4.6 : 3.4), z + (narrow ? 9.2 : 6.5));
    } else if (selectedModuleId && zonePositions[selectedModuleId]) {
      const [x, y, z] = zonePositions[selectedModuleId];
      target.current.set(x, y + 0.92, z);
      destination.current.set(x, y + (narrow ? 4.2 : 3.15), z + (narrow ? 8.8 : 6.15));
    } else {
      destination.current.set(0, narrow ? 10.8 : 8.4, narrow ? 38 : 18.8);
      target.current.set(0, 1.2, 0);
    }
    animating.current = true;
    invalidate();
  }, [focusRevision, invalidate, laboratoryPosition, selectedModuleId, size.height, size.width, view, zonePositions]);

  useEffect(() => {
    if (cameraPanRevision > 0) animating.current = false;
  }, [cameraPanRevision]);

  useFrame((_, delta) => {
    const controls = controlsRef.current;
    if (!controls || !animating.current) return;
    const amount = 1 - Math.exp(-delta * 5.6);
    camera.position.lerp(destination.current, amount);
    controls.target.lerp(target.current, amount);
    controls.update();
    if (camera.position.distanceTo(destination.current) < 0.025 && controls.target.distanceTo(target.current) < 0.025) {
      camera.position.copy(destination.current);
      controls.target.copy(target.current);
      controls.update();
      animating.current = false;
      return;
    }
    invalidate();
  });
  return null;
}

function Dome({ visualStyle, locale, onSelect }: { visualStyle: "detailed" | "simple"; locale: Locale; onSelect: () => void }) {
  const detailed = visualStyle === "detailed";
  return (
    <group
      userData={{ interactionPriority: INTERACTION_PRIORITY.shell }}
      onClick={(event) => selectFromPointer(event, onSelect)}
      onPointerOver={() => { document.body.style.cursor = "pointer"; }}
      onPointerOut={() => { document.body.style.cursor = "default"; }}
    >
      <mesh renderOrder={6}>
        <sphereGeometry args={[11.4, detailed ? 48 : 20, detailed ? 28 : 12, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshPhysicalMaterial
          color={detailed ? "#bdefff" : "#a9efd0"}
          transparent
          opacity={detailed ? 0.11 : 0.075}
          roughness={detailed ? 0.08 : 0.42}
          transmission={detailed ? 0.64 : 0.18}
          thickness={detailed ? 0.3 : 0.08}
          wireframe={!detailed}
          side={THREE.DoubleSide}
        />
      </mesh>
      <mesh position={[0, 0.02, 0]}>
        <torusGeometry args={[11.25, detailed ? 0.1 : 0.06, 8, detailed ? 128 : 56]} />
        <meshStandardMaterial color={detailed ? "#d9e4c4" : "#8be5b7"} metalness={detailed ? 0.62 : 0.18} roughness={0.3} />
      </mesh>
      <Html position={[0, 10.2, 0]} center distanceFactor={15} zIndexRange={[18, 0]}>
        <button
          className="world-landmark-label"
          onPointerDown={stopProjectedLabelEvent}
          onPointerUp={stopProjectedLabelEvent}
          onClick={(event) => selectFromProjectedLabel(event, onSelect)}
        >
          {t(locale, "structure.root")}
        </button>
      </Html>
    </group>
  );
}

interface RootSpiritParticle {
  curveIndex: number;
  offset: number;
  speed: number;
  lift: number;
  phase: number;
}

function RootSpiritFlow({
  curves,
  detailed,
  reducedMotion,
}: {
  curves: THREE.CatmullRomCurve3[];
  detailed: boolean;
  reducedMotion: boolean;
}) {
  const particleCount = detailed ? 54 : 18;
  const sample = useRef(new THREE.Vector3());
  const { geometry, particles } = useMemo(() => {
    const seeds: RootSpiritParticle[] = Array.from({ length: particleCount }, (_, index) => ({
      curveIndex: index % curves.length,
      offset: ((index * 0.61803398875) + (index % 5) * 0.07) % 1,
      speed: 0.045 + (index % 7) * 0.006,
      lift: 0.07 + (index % 4) * 0.025,
      phase: index * 1.73,
    }));
    const positions = new Float32Array(particleCount * 3);
    const point = new THREE.Vector3();
    seeds.forEach((seed, index) => {
      curves[seed.curveIndex].getPointAt(1 - seed.offset, point);
      positions[index * 3] = point.x;
      positions[index * 3 + 1] = point.y + seed.lift;
      positions[index * 3 + 2] = point.z;
    });
    const nextGeometry = new THREE.BufferGeometry();
    const attribute = new THREE.Float32BufferAttribute(positions, 3);
    attribute.setUsage(THREE.DynamicDrawUsage);
    nextGeometry.setAttribute("position", attribute);
    return { geometry: nextGeometry, particles: seeds };
  }, [curves, particleCount]);

  useEffect(() => () => geometry.dispose(), [geometry]);
  useFrame(({ clock }) => {
    if (reducedMotion) return;
    const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
    particles.forEach((particle, index) => {
      const travelled = (clock.elapsedTime * particle.speed + particle.offset) % 1;
      curves[particle.curveIndex].getPointAt(1 - travelled, sample.current);
      positions.setXYZ(
        index,
        sample.current.x,
        sample.current.y + particle.lift + Math.sin(clock.elapsedTime * 1.4 + particle.phase) * 0.018,
        sample.current.z,
      );
    });
    positions.needsUpdate = true;
  });

  return (
    <group>
      <points geometry={geometry} renderOrder={8}>
        <pointsMaterial
          color="#ffbd55"
          size={detailed ? 0.24 : 0.2}
          sizeAttenuation
          transparent
          opacity={detailed ? 0.2 : 0.14}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </points>
      <points geometry={geometry} renderOrder={9}>
        <pointsMaterial
          color="#ffe08a"
          size={detailed ? 0.115 : 0.14}
          sizeAttenuation
          transparent
          opacity={0.9}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </points>
    </group>
  );
}

interface TreeSpiritParticle {
  angle: number;
  offset: number;
  radius: number;
  speed: number;
  sway: number;
}

function TreeSpiritMotes({ detailed, reducedMotion }: { detailed: boolean; reducedMotion: boolean }) {
  const particleCount = detailed ? 34 : 12;
  const { geometry, particles } = useMemo(() => {
    const seeds: TreeSpiritParticle[] = Array.from({ length: particleCount }, (_, index) => ({
      angle: index * 2.399963,
      offset: (index * 0.381966) % 1,
      radius: 0.38 + (index % 8) * (detailed ? 0.12 : 0.1),
      speed: 0.018 + (index % 5) * 0.004,
      sway: 0.12 + (index % 4) * 0.04,
    }));
    const positions = new Float32Array(particleCount * 3);
    seeds.forEach((seed, index) => {
      const progress = seed.offset;
      const angle = seed.angle + progress * 1.8;
      positions[index * 3] = Math.cos(angle) * seed.radius;
      positions[index * 3 + 1] = 0.32 + progress * 6.15;
      positions[index * 3 + 2] = Math.sin(angle) * seed.radius;
    });
    const nextGeometry = new THREE.BufferGeometry();
    const attribute = new THREE.Float32BufferAttribute(positions, 3);
    attribute.setUsage(THREE.DynamicDrawUsage);
    nextGeometry.setAttribute("position", attribute);
    return { geometry: nextGeometry, particles: seeds };
  }, [detailed, particleCount]);

  useEffect(() => () => geometry.dispose(), [geometry]);
  useFrame(({ clock }) => {
    if (reducedMotion) return;
    const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
    particles.forEach((particle, index) => {
      const progress = (clock.elapsedTime * particle.speed + particle.offset) % 1;
      const angle = particle.angle + progress * 1.8 + clock.elapsedTime * 0.055;
      const radius = particle.radius * (0.82 + progress * 0.34);
      positions.setXYZ(
        index,
        Math.cos(angle) * radius + Math.sin(clock.elapsedTime * 0.32 + particle.angle) * particle.sway,
        0.32 + progress * 6.15,
        Math.sin(angle) * radius + Math.cos(clock.elapsedTime * 0.29 + particle.angle) * particle.sway,
      );
    });
    positions.needsUpdate = true;
  });

  return (
    <points geometry={geometry} renderOrder={8}>
      <pointsMaterial
        color="#fff0ad"
        size={detailed ? 0.095 : 0.12}
        sizeAttenuation
        transparent
        opacity={0.76}
        blending={THREE.AdditiveBlending}
        depthWrite={false}
        toneMapped={false}
      />
    </points>
  );
}

function Tree({ visualStyle, locale, growthProgress, growthEvidence, effects, onSelect }: { visualStyle: "detailed" | "simple"; locale: Locale; growthProgress: number; growthEvidence: number; effects: ActiveVisualEffects; onSelect: () => void }) {
  const detailed = visualStyle === "detailed";
  const reducedMotion = useReducedMotion();
  const group = useRef<THREE.Group>(null);
  const invalidate = useThree((state) => state.invalidate);
  const targetScale = (detailed ? 0.96 : 0.78) * Math.max(0.72, growthProgress);
  const initialScale = useRef(targetScale);
  const leafCount = (detailed ? 64 : 16) + Math.min(
    detailed ? 48 : 12,
    Math.floor(Math.log2(1 + Math.max(0, growthEvidence)) * (detailed ? 4 : 1.4)),
  );
  useEffect(() => {
    if (reducedMotion && group.current) group.current.scale.setScalar(targetScale);
    invalidate();
  }, [invalidate, reducedMotion, targetScale]);
  useFrame((_, delta) => {
    if (!group.current || reducedMotion) return;
    const current = group.current.scale.x;
    if (Math.abs(current - targetScale) < 0.0005) {
      group.current.scale.setScalar(targetScale);
      return;
    }
    group.current.scale.setScalar(THREE.MathUtils.lerp(current, targetScale, 1 - Math.exp(-delta * 3.6)));
    invalidate();
  });
  const leafPositions = useMemo(() => {
    const points: Array<[number, number, number, number]> = [];
    for (let index = 0; index < leafCount; index += 1) {
      const angle = index * 2.399;
      const radius = detailed ? 1.05 + (index % 12) * 0.18 : 1.15 + (index % 4) * 0.32;
      points.push([
        Math.cos(angle) * radius,
        (detailed ? 4.32 : 4.85) + ((index * 13) % (detailed ? 15 : 6)) * (detailed ? 0.13 : 0.22),
        Math.sin(angle) * radius,
        (detailed ? 0.24 : 0.72) + (index % (detailed ? 6 : 3)) * (detailed ? 0.035 : 0.08),
      ]);
    }
    return points;
  }, [detailed, leafCount]);
  const leafSprigs = useMemo(() => detailed ? Array.from({ length: 18 }, (_, index) => {
    const angle = index * 2.399 + 0.62;
    const radius = 1.25 + (index % 10) * 0.22;
    return {
      position: [Math.cos(angle) * radius, 4.42 + ((index * 7) % 12) * 0.15, Math.sin(angle) * radius] as [number, number, number],
      rotation: angle + (index % 3) * 0.24,
      scale: 0.72 + (index % 4) * 0.1,
    };
  }) : [], [detailed]);
  const roots = useMemo(() => Array.from({ length: detailed ? 12 : 6 }, (_, index) => {
    const angle = (index / (detailed ? 12 : 6)) * Math.PI * 2;
    const start = new THREE.Vector3(Math.cos(angle) * 0.42, 0.3, Math.sin(angle) * 0.42);
    const bend = new THREE.Vector3(Math.cos(angle + 0.15) * 1.9, 0.14, Math.sin(angle + 0.15) * 1.9);
    const end = new THREE.Vector3(Math.cos(angle) * (detailed ? 4.2 : 3.1), 0.04, Math.sin(angle) * (detailed ? 4.2 : 3.1));
    return new THREE.CatmullRomCurve3([start, bend, end]);
  }), [detailed]);
  const crownBranches = useMemo(() => detailed ? Array.from({ length: 11 }, (_, index) => {
    const angle = (index / 11) * Math.PI * 2 + (index % 2) * 0.18;
    const startHeight = 3.1 + (index % 4) * 0.28;
    const reach = 2.45 + (index % 3) * 0.48;
    const start = new THREE.Vector3(Math.cos(angle) * 0.32, startHeight, Math.sin(angle) * 0.32);
    const bend = new THREE.Vector3(
      Math.cos(angle + 0.16) * reach * 0.55,
      startHeight + 0.8 + (index % 2) * 0.32,
      Math.sin(angle + 0.16) * reach * 0.55,
    );
    const end = new THREE.Vector3(
      Math.cos(angle) * reach,
      4.65 + (index % 5) * 0.24,
      Math.sin(angle) * reach,
    );
    return new THREE.CatmullRomCurve3([start, bend, end]);
  }) : [], [detailed]);
  const vines = useMemo(() => detailed ? Array.from({ length: 7 }, (_, index) => {
    const angle = (index / 7) * Math.PI * 2 + 0.4;
    const start = new THREE.Vector3(Math.cos(angle) * 2.3, 5.45 + (index % 3) * 0.36, Math.sin(angle) * 2.3);
    const middle = new THREE.Vector3(Math.cos(angle + 0.22) * 2.55, 4.25, Math.sin(angle + 0.22) * 2.55);
    const end = new THREE.Vector3(Math.cos(angle + 0.42) * 2.1, 2.65 + (index % 2) * 0.52, Math.sin(angle + 0.42) * 2.1);
    return new THREE.CatmullRomCurve3([start, middle, end]);
  }) : [], [detailed]);
  const vineLeafPositions = useMemo(
    () => vines.map((curve) => [0.32, 0.61, 0.87].map((offset) => ({ offset, position: curve.getPoint(offset) }))),
    [vines],
  );
  return (
    <group
      ref={group}
      userData={{ interactionPriority: INTERACTION_PRIORITY.landmark }}
      scale={initialScale.current}
      position={[0, 0, -0.2]}
      onClick={(event) => selectFromPointer(event, onSelect)}
      onPointerOver={() => { document.body.style.cursor = "pointer"; }}
      onPointerOut={() => { document.body.style.cursor = "default"; }}
    >
      {roots.map((curve, index) => (
        <mesh key={`root-${index}`} castShadow>
          <tubeGeometry args={[curve, detailed ? 30 : 16, detailed ? 0.13 - (index % 3) * 0.02 : 0.1, detailed ? 8 : 5, false]} />
          <meshStandardMaterial color={index % 3 === 0 ? "#6b4932" : "#76563a"} roughness={0.92} />
        </mesh>
      ))}
      {effects.particles && <RootSpiritFlow curves={roots} detailed={detailed} reducedMotion={reducedMotion} />}
      {effects.particles && <TreeSpiritMotes detailed={detailed} reducedMotion={reducedMotion} />}
      <mesh position={[0, 2.35, 0]} castShadow>
        <cylinderGeometry args={[detailed ? 0.76 : 0.72, detailed ? 1.38 : 1.15, 5.15, detailed ? 24 : 7]} />
        <meshStandardMaterial color={detailed ? "#69472f" : "#765137"} roughness={0.9} />
      </mesh>
      {crownBranches.map((curve, index) => (
        <mesh key={`crown-branch-${index}`} castShadow>
          <tubeGeometry args={[curve, 34, 0.19 - (index % 3) * 0.025, 10, false]} />
          <meshStandardMaterial color={index % 3 === 0 ? "#795136" : "#65412e"} roughness={0.94} />
        </mesh>
      ))}
      {detailed && Array.from({ length: 7 }, (_, index) => {
        const angle = (index / 7) * Math.PI * 2;
        return (
          <mesh key={`bark-${index}`} position={[Math.cos(angle) * 0.74, 2.35, Math.sin(angle) * 0.74]} rotation={[0, -angle, 0]} scale={[0.12, 2.25, 0.08]}>
            <boxGeometry />
            <meshStandardMaterial color={index % 2 ? "#4e3427" : "#865f3d"} roughness={1} />
          </mesh>
        );
      })}
      {(!detailed ? [[-1.15, 4.15, 0.25, -0.52], [1.15, 4.35, -0.15, 0.52], [0.1, 4.55, 1.0, 0.12]] : []).map(
        ([x, y, z, rotation], index) => (
          <mesh key={index} position={[x, y, z]} rotation={[0, 0, rotation]} castShadow>
            <cylinderGeometry args={[0.22, 0.42, 3.1, 6]} />
            <meshStandardMaterial color="#7d573a" roughness={0.88} />
          </mesh>
        ),
      )}
      {detailed && (
        <>
          <mesh position={[0, 2.1, 1.08]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[0.42, 0.13, 12, 28]} />
            <meshStandardMaterial color="#30241c" roughness={1} />
          </mesh>
          <mesh position={[0, 3.13, 0.76]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[0.29, 0.035, 8, 36]} />
            <meshStandardMaterial color="#9be8bd" emissive="#4ecb96" emissiveIntensity={1.1} roughness={0.46} />
          </mesh>
          {[[-0.76, 1.45, 0.75], [0.72, 3.1, 0.72], [-0.38, 3.75, 0.95]].map(([x, y, z], index) => (
            <mesh key={`moss-${index}`} position={[x, y, z]} scale={[0.7, 0.28, 0.14]}>
              <dodecahedronGeometry args={[0.5, 0]} />
              <meshStandardMaterial color={index % 2 ? "#72994d" : "#5f8d49"} roughness={1} />
            </mesh>
          ))}
        </>
      )}
      {leafPositions.map(([x, y, z, scale], index) => (
        <group key={index} position={[x, y, z]} rotation={[0.08 * (index % 3), index * 0.31, 0.06 * (index % 4)]}>
          <mesh scale={detailed ? [scale * 1.18, scale * 0.82, scale] : [scale, scale, scale]} castShadow>
            {detailed ? <icosahedronGeometry args={[1, 1]} /> : <dodecahedronGeometry args={[1, 0]} />}
            <meshPhysicalMaterial
              color={index % 11 === 0 ? "#b4ca68" : index % 5 === 0 ? "#73a94e" : index % 3 === 0 ? "#397650" : "#4f9560"}
              roughness={detailed ? 0.68 : 0.76}
              clearcoat={detailed ? 0.16 : 0}
              clearcoatRoughness={0.72}
            />
          </mesh>
          {detailed && index % 3 === 0 && (
            <mesh position={[scale * 0.62, scale * 0.08, scale * 0.22]} scale={[scale * 0.58, scale * 0.38, scale * 0.5]}>
              <dodecahedronGeometry args={[1, 0]} />
              <meshStandardMaterial color={index % 2 ? "#9bcf66" : "#6fbf67"} roughness={0.76} />
            </mesh>
          )}
        </group>
      ))}
      {leafSprigs.map((sprig, index) => (
        <group key={`leaf-sprig-${index}`} position={sprig.position} rotation={[0.15 * (index % 3), sprig.rotation, 0.12 * ((index % 4) - 1)]} scale={sprig.scale}>
          <mesh rotation={[0, 0, 0.54]} position={[-0.16, 0, 0]} scale={[0.38, 0.1, 0.2]} castShadow>
            <sphereGeometry args={[1, 9, 6]} />
            <meshStandardMaterial color={index % 3 === 0 ? "#9ac967" : "#5ea966"} roughness={0.86} />
          </mesh>
          <mesh rotation={[0, 0, -0.54]} position={[0.16, 0.03, 0]} scale={[0.38, 0.1, 0.2]} castShadow>
            <sphereGeometry args={[1, 9, 6]} />
            <meshStandardMaterial color={index % 4 === 0 ? "#b1d477" : "#4d9159"} roughness={0.88} />
          </mesh>
          <mesh rotation={[0, 0, Math.PI / 2]} scale={[0.035, 0.28, 0.035]}>
            <cylinderGeometry args={[1, 1, 1, 5]} />
            <meshStandardMaterial color="#486f43" roughness={1} />
          </mesh>
        </group>
      ))}
      {vines.map((curve, index) => (
        <group key={`vine-${index}`}>
          <mesh>
            <tubeGeometry args={[curve, 24, 0.035, 6, false]} />
            <meshStandardMaterial color={index % 2 ? "#467d43" : "#5b984f"} roughness={0.94} />
          </mesh>
          {vineLeafPositions[index].map(({ offset, position }) => (
            <mesh key={offset} position={position} scale={[0.18, 0.08, 0.1]} rotation={[0, index * 0.5, 0.5]}>
              <sphereGeometry args={[0.5, 8, 6]} />
              <meshStandardMaterial color="#78aa55" roughness={1} />
            </mesh>
          ))}
        </group>
      ))}
      {detailed && [[-2.35, 4.3, 1.5], [2.55, 4.55, 0.6], [1.2, 4.05, -2.35]].map(([x, y, z], index) => (
        <group key={`lantern-${index}`} position={[x, y, z]}>
          <mesh position={[0, 0.42, 0]}>
            <cylinderGeometry args={[0.018, 0.018, 0.85, 5]} />
            <meshStandardMaterial color="#456744" roughness={0.9} />
          </mesh>
          <mesh>
            <octahedronGeometry args={[0.16, 1]} />
            <meshPhysicalMaterial color="#ffe29a" emissive="#ffbd62" emissiveIntensity={effects.glow ? 2.4 : 0.12} roughness={0.28} transmission={0.12} />
          </mesh>
          {effects.glow && <pointLight color="#ffd080" intensity={1.6} distance={2.4} />}
        </group>
      ))}
      {detailed && [[-1.15, 0.42, 0.95], [1.38, 0.34, 0.6], [0.65, 0.3, -1.2]].map(([x, y, z], index) => (
        <group key={`mushroom-${index}`} position={[x, y, z]} scale={0.72 + index * 0.1}>
          <mesh position={[0, 0.11, 0]}><cylinderGeometry args={[0.04, 0.06, 0.24, 7]} /><meshStandardMaterial color="#e7d7b4" roughness={0.9} /></mesh>
          <mesh position={[0, 0.25, 0]} scale={[1, 0.42, 1]}><sphereGeometry args={[0.16, 12, 8]} /><meshStandardMaterial color={index % 2 ? "#d9785d" : "#e9ad61"} emissive="#8f4e32" emissiveIntensity={0.16} roughness={0.82} /></mesh>
        </group>
      ))}
      {effects.glow && <pointLight position={[0, 4.5, 0]} color="#ffd36b" intensity={detailed ? 5.5 : 3.4} distance={9} />}
      {effects.particles && <Sparkles count={detailed ? 66 : 28} scale={[5.5, 6.5, 5.5]} size={detailed ? 1.8 : 2.4} speed={reducedMotion ? 0 : 0.22} color="#ffe59a" />}
      <Html position={[0, 7.55, 0]} center distanceFactor={11} zIndexRange={[19, 0]}>
        <button
          className="world-landmark-label tree-label"
          onPointerDown={stopProjectedLabelEvent}
          onPointerUp={stopProjectedLabelEvent}
          onClick={(event) => selectFromProjectedLabel(event, onSelect)}
        >
          {t(locale, "structure.tree")}
        </button>
      </Html>
    </group>
  );
}

function AncientRuins({ glowEnabled }: { glowEnabled: boolean }) {
  const columns = useMemo(() => Array.from({ length: 8 }, (_, index) => {
    const angle = Math.PI + (index / 7) * Math.PI;
    const radius = 8.3 + (index % 2) * 0.45;
    return {
      x: Math.cos(angle) * radius,
      z: Math.sin(angle) * radius,
      height: 1.8 + (index % 4) * 0.58,
      tilt: ((index % 3) - 1) * 0.08,
    };
  }), []);
  return (
    <group>
      <mesh position={[0, 0.12, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <ringGeometry args={[6.9, 9.2, 64]} />
        <meshStandardMaterial color="#667062" roughness={0.98} transparent opacity={0.72} />
      </mesh>
      <mesh position={[0, 0.16, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[7.65, 7.82, 64]} />
        <meshStandardMaterial color="#75d3aa" emissive="#3fb98a" emissiveIntensity={glowEnabled ? 0.7 : 0.05} transparent opacity={0.72} />
      </mesh>
      {Array.from({ length: 16 }, (_, index) => {
        const angle = (index / 16) * Math.PI * 2;
        const radius = 7.72;
        return (
          <mesh key={`rune-${index}`} position={[Math.cos(angle) * radius, 0.19, Math.sin(angle) * radius]} rotation={[-Math.PI / 2, 0, -angle]}>
            <boxGeometry args={[0.34, 0.08, 0.72]} />
            <meshStandardMaterial color={index % 3 === 0 ? "#8de4bd" : "#788d7d"} emissive="#50c996" emissiveIntensity={glowEnabled ? (index % 3 === 0 ? 0.8 : 0.18) : 0.03} roughness={0.86} />
          </mesh>
        );
      })}
      {columns.map((column, index) => (
        <group key={index} position={[column.x, column.height / 2, column.z]} rotation={[column.tilt, -index * 0.35, column.tilt * 0.7]}>
          <mesh castShadow>
            <cylinderGeometry args={[0.38, 0.48, column.height, 8]} />
            <meshStandardMaterial color={index % 2 ? "#7c8275" : "#8d8e7d"} roughness={0.98} />
          </mesh>
          <mesh position={[0, column.height / 2 + 0.14, 0]} rotation={[0, index * 0.4, 0]}>
            <boxGeometry args={[0.86, 0.22, 0.86]} />
            <meshStandardMaterial color="#85897b" roughness={1} />
          </mesh>
          {index % 2 === 0 && (
            <mesh position={[0, 0.15, 0.41]}>
              <torusGeometry args={[0.16, 0.035, 6, 18]} />
              <meshStandardMaterial color="#8be6bf" emissive="#58dba5" emissiveIntensity={glowEnabled ? 1.1 : 0.06} />
            </mesh>
          )}
        </group>
      ))}
      {[[-6.2, 0.62, 2.5], [6.0, 0.62, -2.9], [-3.4, 0.62, -6.4], [3.8, 0.62, 6.2]].map(([x, y, z], index) => (
        <group key={`lamp-${index}`} position={[x, y, z]}>
          <mesh>
            <cylinderGeometry args={[0.1, 0.14, 1.2, 7]} />
            <meshStandardMaterial color="#4a4c46" metalness={0.45} roughness={0.6} />
          </mesh>
          <mesh position={[0, 0.72, 0]}>
            <octahedronGeometry args={[0.2, 0]} />
            <meshStandardMaterial color="#ffd17a" emissive="#ffaf4f" emissiveIntensity={glowEnabled ? 2.2 : 0.08} />
          </mesh>
          {glowEnabled && <pointLight position={[0, 0.72, 0]} color="#ffc267" intensity={2.4} distance={3.5} />}
        </group>
      ))}
      <group position={[0, 1.75, -8.25]}>
        {[-1.65, 1.65].map((x) => (
          <group key={x} position={[x, 0, 0]}>
            <mesh castShadow>
              <cylinderGeometry args={[0.45, 0.58, 3.5, 10]} />
              <meshStandardMaterial color="#7d8277" roughness={0.98} />
            </mesh>
            <mesh position={[0, 1.9, 0]}>
              <boxGeometry args={[0.92, 0.28, 0.86]} />
              <meshStandardMaterial color="#8b8c7c" roughness={1} />
            </mesh>
          </group>
        ))}
        <mesh position={[0, 1.9, 0]} castShadow>
          <boxGeometry args={[4.3, 0.48, 0.82]} />
          <meshStandardMaterial color="#85877a" roughness={0.98} />
        </mesh>
        <mesh position={[0, 0.2, 0.44]}>
          <torusGeometry args={[0.8, 0.075, 8, 32]} />
          <meshStandardMaterial color="#8de6c0" emissive="#4fd19d" emissiveIntensity={glowEnabled ? 1.15 : 0.08} transparent opacity={0.82} />
        </mesh>
        {glowEnabled && <pointLight position={[0, 0.25, 1.1]} color="#7ee7bd" intensity={7} distance={5} />}
      </group>
      {Array.from({ length: 10 }, (_, index) => (
        <mesh key={`step-${index}`} position={[(index % 2 ? 0.34 : -0.28), 0.16, 6.6 - index * 1.25]} rotation={[-Math.PI / 2, 0, (index % 3 - 1) * 0.08]}>
          <circleGeometry args={[0.62 + (index % 3) * 0.08, 8]} />
          <meshStandardMaterial color={index % 3 === 0 ? "#788c7d" : "#6f776d"} roughness={1} />
        </mesh>
      ))}
      {glowEnabled && <spotLight position={[-6, 11, 5]} angle={0.34} penumbra={0.8} intensity={4.5} color="#dfffc5" distance={25} />}
      {glowEnabled && <spotLight position={[7, 9, -3]} angle={0.28} penumbra={0.9} intensity={3.2} color="#9de7ca" distance={22} />}
    </group>
  );
}

function Ground() {
  const plantPositions = useMemo(() => Array.from({ length: 54 }, (_, index) => {
    const angle = index * 2.17;
    const radius = 3.3 + ((index * 11) % 75) / 10;
    return [Math.cos(angle) * radius, Math.sin(angle) * radius, 0.08 + (index % 5) * 0.025] as const;
  }), []);
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[11.2, 64]} />
        <meshStandardMaterial color="#1f6a50" roughness={0.95} transparent opacity={0.72} />
      </mesh>
      <mesh position={[0, 0.035, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[5.4, 6.4, 64]} />
        <meshPhysicalMaterial color="#2fc7c4" roughness={0.18} metalness={0.08} transparent opacity={0.5} />
      </mesh>
      <mesh position={[0, 0.055, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[7.5, 7.85, 64]} />
        <meshStandardMaterial color="#d9e8c7" roughness={0.7} transparent opacity={0.24} />
      </mesh>
      {plantPositions.map(([x, z, scale], index) => (
        <group key={index} position={[x, 0, z]} rotation={[0, index * 0.73, 0]} scale={0.7 + (index % 4) * 0.1}>
          <mesh position={[0, scale * 2.4, 0]}>
            <cylinderGeometry args={[scale * 0.08, scale * 0.11, scale * 4.6, 6]} />
            <meshStandardMaterial color="#3d8058" roughness={0.92} />
          </mesh>
          {[-1, 1].map((direction) => (
            <mesh key={direction} position={[direction * scale * 0.58, scale * (2.1 + direction * 0.35), 0]} rotation={[0, 0, direction * 0.48]} scale={[scale * 1.15, scale * 0.35, scale * 0.65]}>
              <sphereGeometry args={[0.7, 8, 6]} />
              <meshStandardMaterial color={index % 5 === 0 ? "#94b95b" : "#4f9963"} roughness={0.95} />
            </mesh>
          ))}
          {index % 7 === 0 && (
            <mesh position={[0, scale * 4.7, 0]}>
              <dodecahedronGeometry args={[scale * 0.38, 0]} />
              <meshStandardMaterial color={index % 2 ? "#f0b45f" : "#dc7f68"} emissive="#8c493b" emissiveIntensity={0.12} />
            </mesh>
          )}
        </group>
      ))}
    </group>
  );
}

function SeedGlyph({ color, detailed }: { color: string; detailed: boolean }) {
  return (
    <group position={[0, 0.86, 0]} rotation={[0, -0.25, 0]}>
      <mesh scale={[0.58, 0.82, 0.46]} rotation={[0, 0, 0.38]} castShadow>
        <sphereGeometry args={[0.48, 20, 14]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.58} roughness={0.48} />
      </mesh>
      <mesh position={[0.08, 0.56, 0]} rotation={[0, 0, -0.45]}>
        <cylinderGeometry args={[0.055, 0.075, 0.72, 7]} />
        <meshStandardMaterial color="#9ed874" />
      </mesh>
      <mesh position={[-0.16, 0.78, 0]} scale={[0.48, 0.17, 0.34]} rotation={[0, 0, 0.42]}>
        <sphereGeometry args={[0.55, 14, 10]} />
        <meshStandardMaterial color="#9ce580" emissive="#4f9f55" emissiveIntensity={0.35} />
      </mesh>
      <mesh position={[0.31, 0.88, 0.02]} scale={[0.44, 0.16, 0.31]} rotation={[0, 0, -0.38]}>
        <sphereGeometry args={[0.55, 14, 10]} />
        <meshStandardMaterial color="#77cb6f" emissive="#3b8950" emissiveIntensity={0.35} />
      </mesh>
      {(detailed ? [-0.4, -0.2, 0, 0.2, 0.4] : [-0.2, 0.2]).map((x, index, roots) => (
        <mesh key={x} position={[x * 0.55, -0.57, 0]} rotation={[0, 0, (index - 1) * 0.42]}>
          <cylinderGeometry args={[detailed ? 0.014 : 0.03, detailed ? 0.04 : 0.065, detailed ? 0.72 : 0.5, detailed ? 6 : 5]} />
          <meshStandardMaterial color="#c49a62" emissive="#74502e" emissiveIntensity={0.25} />
        </mesh>
      ))}
    </group>
  );
}

function BrainGlyph({ color, detailed }: { color: string; detailed: boolean }) {
  const lobes: Array<[number, number, number, number]> = [
    [-0.32, 0.12, 0.04, 0.44], [0.32, 0.12, 0.04, 0.44],
    [-0.25, 0.48, 0, 0.4], [0.25, 0.48, 0, 0.4],
    [-0.38, -0.2, 0, 0.34], [0.38, -0.2, 0, 0.34],
  ];
  return (
    <group position={[0, 1.03, 0]} scale={[1.08, 0.94, 0.9]}>
      {(detailed ? lobes : lobes.slice(0, 4)).map(([x, y, z, scale], index) => (
        <mesh key={index} position={[x, y, z]} scale={[scale * 1.1, scale, scale]} castShadow>
          <sphereGeometry args={[1, 18, 14]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.48 + (index % 2) * 0.12} roughness={0.58} />
        </mesh>
      ))}
      <mesh position={[0, -0.58, 0]}>
        <cylinderGeometry args={[0.12, 0.18, 0.5, 8]} />
        <meshStandardMaterial color="#d3a9a2" emissive={color} emissiveIntensity={0.2} />
      </mesh>
      {detailed && (
        <mesh position={[0, 0.15, 0.43]} scale={[0.035, 0.62, 0.035]}>
          <boxGeometry />
          <meshStandardMaterial color="#432f46" transparent opacity={0.7} />
        </mesh>
      )}
    </group>
  );
}

function HookGlyph({ color, detailed }: { color: string; detailed: boolean }) {
  return (
    <group position={[0, 0.88, 0]}>
      {[-0.46, 0.46].map((x) => (
        <mesh key={x} position={[x, 0, 0]} castShadow>
          <boxGeometry args={[0.18, 1.55, 0.3]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.55} metalness={0.35} roughness={0.3} />
        </mesh>
      ))}
      <mesh position={[0, 0.68, 0]} castShadow>
        <boxGeometry args={[1.1, 0.2, 0.32]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.65} metalness={0.35} roughness={0.3} />
      </mesh>
      {detailed && (
        <mesh position={[0, -0.05, 0]}>
          <planeGeometry args={[0.72, 1.18]} />
          <meshBasicMaterial color="#8df2d3" transparent opacity={0.22} side={THREE.DoubleSide} />
        </mesh>
      )}
      <mesh position={[0, -0.05, 0.14]} rotation={[0, 0, -Math.PI / 2]}>
        <coneGeometry args={[0.15, 0.4, 8]} />
        <meshStandardMaterial color="#effff9" emissive={color} emissiveIntensity={0.8} />
      </mesh>
    </group>
  );
}

function EvolutionGlyph({ color, detailed }: { color: string; detailed: boolean }) {
  return (
    <group position={[0, 0.92, 0]} rotation={[Math.PI / 2.8, 0, 0]}>
      {(detailed ? [0.3, 0.46, 0.63, 0.8] : [0.42, 0.72]).map((radius, index) => (
        <mesh key={radius} position={[0, 0, index * -0.07]}>
          <torusGeometry args={[radius, 0.055 + index * 0.012, 8, 42]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.42 + index * 0.2} roughness={0.45} />
        </mesh>
      ))}
      <mesh position={[0, 0, 0.12]} rotation={[0, 0, -0.5]}>
        <cylinderGeometry args={[0.04, 0.06, 1.15, 7]} />
        <meshStandardMaterial color="#d4b26f" />
      </mesh>
      <mesh position={[0.25, 0.38, 0.14]} scale={[0.44, 0.16, 0.28]} rotation={[0, 0, 0.55]}>
        <sphereGeometry args={[0.5, 12, 9]} />
        <meshStandardMaterial color="#a9e578" emissive="#4b9a56" emissiveIntensity={0.35} />
      </mesh>
    </group>
  );
}

function RolesGlyph({ color, detailed }: { color: string; detailed: boolean }) {
  return (
    <group position={[0, 0.8, 0]}>
      {(detailed ? [
        [-0.46, -0.05, 0.88],
        [0, 0.12, 1.08],
        [0.46, -0.05, 0.88],
      ] : [[-0.28, -0.02, 0.95], [0.28, 0.08, 1.08]]).map(([x, y, scale], index) => (
        <group key={index} position={[x, y, index === 1 ? 0.12 : 0]} scale={scale}>
          <mesh position={[0, 0.45, 0]} castShadow>
            <sphereGeometry args={[0.23, 16, 12]} />
            <meshStandardMaterial color={index === 1 ? "#f2d3ad" : "#dcb58f"} roughness={0.62} />
          </mesh>
          <mesh position={[0, -0.03, 0]} scale={[0.62, 0.72, 0.42]} castShadow>
            <sphereGeometry args={[0.55, 16, 12]} />
            <meshStandardMaterial color={color} emissive={color} emissiveIntensity={index === 1 ? 0.62 : 0.4} roughness={0.5} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

function ResourceGlyph({ color, detailed }: { color: string; detailed: boolean }) {
  return (
    <group position={[0, 0.82, 0]}>
      <mesh castShadow>
        <cylinderGeometry args={[0.62, 0.72, 1.35, 20, 1, true]} />
        <meshPhysicalMaterial color="#bdefff" transparent opacity={0.3} transmission={0.35} roughness={0.18} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0, -0.28, 0]}>
        <cylinderGeometry args={[0.55, 0.63, 0.72, 20]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.46} transparent opacity={0.82} />
      </mesh>
      {[-0.72, 0.72].map((y) => (
        <mesh key={y} position={[0, y, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.67, 0.06, 8, 32]} />
          <meshStandardMaterial color="#d9fff4" metalness={0.45} roughness={0.25} />
        </mesh>
      ))}
      {detailed && (
        <group>
          <mesh position={[0.82, 0.15, 0]} rotation={[0, 0, -Math.PI / 2]}>
            <torusGeometry args={[0.35, 0.045, 7, 22, Math.PI * 1.5]} />
            <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.75} />
          </mesh>
          <mesh position={[1.03, 0.42, 0]} rotation={[0, 0, -0.15]}>
            <coneGeometry args={[0.1, 0.28, 7]} />
            <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.75} />
          </mesh>
        </group>
      )}
    </group>
  );
}

function ReceiptGlyph({ color, detailed }: { color: string; detailed: boolean }) {
  return (
    <group position={[0, 0.82, 0]} rotation={[0, -0.28, 0]}>
      {(detailed ? [0, 1, 2] : [1, 2]).map((index) => (
        <mesh key={index} position={[index * 0.11 - 0.1, index * 0.12 - 0.12, index * -0.08]} castShadow>
          <boxGeometry args={[0.92, 1.18, 0.08]} />
          <meshStandardMaterial color={index === 2 ? "#e9fff7" : "#9fcdbd"} emissive={index === 2 ? color : "#1d5e4a"} emissiveIntensity={index === 2 ? 0.24 : 0.1} roughness={0.72} />
        </mesh>
      ))}
      <mesh position={[0.05, 0.12, 0.14]} rotation={[0, 0, -0.7]}>
        <boxGeometry args={[0.09, 0.45, 0.08]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.7} />
      </mesh>
      <mesh position={[0.31, 0.21, 0.14]} rotation={[0, 0, 0.7]}>
        <boxGeometry args={[0.09, 0.76, 0.08]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.7} />
      </mesh>
      {(detailed ? [-0.32, -0.1, 0.12] : [-0.22]).map((y) => (
        <mesh key={y} position={[-0.12, y, 0.15]}>
          <boxGeometry args={[0.48, 0.035, 0.04]} />
          <meshStandardMaterial color="#4c8371" />
        </mesh>
      ))}
    </group>
  );
}

function GenericOrganGlyph({ moduleId, color, detailed }: { moduleId: string; color: string; detailed: boolean }) {
  const hash = stableIdHash(moduleId);
  const sides = 5 + (hash % 4);
  const rotation = ((hash % 360) * Math.PI) / 180;
  return (
    <group position={[0, 0.88, 0]} rotation={[0.12, rotation, 0]}>
      <mesh castShadow>
        <dodecahedronGeometry args={[detailed ? 0.62 : 0.54, detailed ? 1 : 0]} />
        <meshStandardMaterial color="#d9efe6" emissive={color} emissiveIntensity={0.32} roughness={0.42} metalness={0.12} />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.82, 0.045, sides, detailed ? 40 : 20]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.82} transparent opacity={0.82} />
      </mesh>
      {detailed && (
        <mesh rotation={[0.45, 0.3, Math.PI / 2]}>
          <torusGeometry args={[0.95, 0.025, 7, 40]} />
          <meshBasicMaterial color="#f4fff9" transparent opacity={0.52} />
        </mesh>
      )}
    </group>
  );
}

function OrganGlyph({ moduleId, color, detailed }: { moduleId: string; color: string; detailed: boolean }) {
  if (moduleId === "seed-memory") return <SeedGlyph color={color} detailed={detailed} />;
  if (moduleId === "brain") return <BrainGlyph color={color} detailed={detailed} />;
  if (moduleId === "hooks") return <HookGlyph color={color} detailed={detailed} />;
  if (moduleId === "evolution") return <EvolutionGlyph color={color} detailed={detailed} />;
  if (moduleId === "roles") return <RolesGlyph color={color} detailed={detailed} />;
  if (moduleId === "resources") return <ResourceGlyph color={color} detailed={detailed} />;
  if (moduleId === "receipts") return <ReceiptGlyph color={color} detailed={detailed} />;
  return <GenericOrganGlyph moduleId={moduleId} color={color} detailed={detailed} />;
}

function OrganSanctuary({ moduleId, color, activityActive, glowEnabled }: { moduleId: string; color: string; activityActive: boolean; glowEnabled: boolean }) {
  const glow = glowEnabled ? (activityActive ? 1.05 : 0.38) : 0.04;
  const ringMaterial = <meshStandardMaterial color={color} emissive={color} emissiveIntensity={glow} transparent opacity={activityActive ? 0.86 : 0.58} roughness={0.52} />;
  const seedMemoryRoots = useMemo(() => Array.from({ length: 6 }, (_, index) => {
    const angle = (index / 6) * Math.PI * 2;
    return new THREE.CatmullRomCurve3([
      new THREE.Vector3(Math.cos(angle) * 0.35, 0.34, Math.sin(angle) * 0.35),
      new THREE.Vector3(Math.cos(angle + 0.14) * 1.05, 0.22, Math.sin(angle + 0.14) * 1.05),
      new THREE.Vector3(Math.cos(angle) * 1.5, 0.14, Math.sin(angle) * 1.5),
    ]);
  }), []);
  if (moduleId === "seed-memory") {
    return (
      <group>
        {seedMemoryRoots.map((curve, index) => (
          <mesh key={index}><tubeGeometry args={[curve, 18, 0.035, 6, false]} />{ringMaterial}</mesh>
        ))}
        {[0, 1, 2].map((index) => {
          const angle = index * Math.PI * 2 / 3 + 0.4;
          return <mesh key={index} position={[Math.cos(angle) * 1.38, 0.28, Math.sin(angle) * 1.38]} scale={[0.12, 0.25, 0.12]}><dodecahedronGeometry args={[1, 0]} />{ringMaterial}</mesh>;
        })}
      </group>
    );
  }
  if (moduleId === "brain") {
    return (
      <group>
        {Array.from({ length: 6 }, (_, index) => {
          const angle = index * Math.PI / 3;
          return (
            <group key={index} position={[Math.cos(angle) * 1.3, 0.52, Math.sin(angle) * 1.3]}>
              <mesh><octahedronGeometry args={[0.16, 0]} />{ringMaterial}</mesh>
              <mesh position={[0, -0.29, 0]}><cylinderGeometry args={[0.025, 0.04, 0.5, 6]} />{ringMaterial}</mesh>
            </group>
          );
        })}
        <mesh position={[0, 0.38, 0]} rotation={[-Math.PI / 2, 0, 0]}><torusGeometry args={[1.08, 0.025, 7, 48]} />{ringMaterial}</mesh>
      </group>
    );
  }
  if (moduleId === "hooks") {
    return (
      <group>
        {[-1.18, 1.18].map((x) => <mesh key={x} position={[x, 0.82, 0]}><boxGeometry args={[0.25, 1.4, 0.35]} /><meshStandardMaterial color="#879388" roughness={0.94} /></mesh>)}
        <mesh position={[0, 1.44, 0]}><boxGeometry args={[2.58, 0.22, 0.38]} /><meshStandardMaterial color="#879388" roughness={0.94} /></mesh>
        <mesh position={[0, 1.42, 0.21]}><boxGeometry args={[1.42, 0.035, 0.035]} />{ringMaterial}</mesh>
      </group>
    );
  }
  if (moduleId === "evolution") {
    return (
      <group>
        {[0.92, 1.2, 1.5].map((radius, index) => <mesh key={radius} position={[0, 0.34 + index * 0.018, 0]} rotation={[-Math.PI / 2, 0, index * 0.23]}><torusGeometry args={[radius, 0.025 + index * 0.008, 7, 52]} />{ringMaterial}</mesh>)}
        {Array.from({ length: 4 }, (_, index) => {
          const angle = index * Math.PI / 2 + 0.4;
          return <mesh key={index} position={[Math.cos(angle) * 1.45, 0.42, Math.sin(angle) * 1.45]} rotation={[0, -angle, 0]}><boxGeometry args={[0.14, 0.36, 0.08]} />{ringMaterial}</mesh>;
        })}
      </group>
    );
  }
  if (moduleId === "roles") {
    return (
      <group>
        {[-1, 0, 1].map((x, index) => (
          <group key={x} position={[x, 0.72 + (index === 1 ? 0.16 : 0), -0.2 + Math.abs(x) * 0.2]}>
            <mesh><cylinderGeometry args={[0.035, 0.055, 1.25, 6]} /><meshStandardMaterial color="#82745d" roughness={0.88} /></mesh>
            <mesh position={[0.22, 0.38, 0]}><planeGeometry args={[0.42, 0.3]} />{ringMaterial}</mesh>
          </group>
        ))}
      </group>
    );
  }
  if (moduleId === "resources") {
    return (
      <group>
        {[-1.14, 1.14].map((x) => <mesh key={x} position={[x, 0.52, 0]}><cylinderGeometry args={[0.24, 0.3, 0.9, 14]} /><meshStandardMaterial color="#6f8580" metalness={0.2} roughness={0.58} /></mesh>)}
        {[-1, 1].map((direction) => <mesh key={direction} position={[direction * 0.72, 0.46, 0]} rotation={[0, 0, direction * Math.PI / 2]}><torusGeometry args={[0.48, 0.06, 8, 28, Math.PI]} />{ringMaterial}</mesh>)}
      </group>
    );
  }
  if (moduleId === "receipts") return (
    <group>
      {[-1.25, -0.86, 0.86, 1.25].map((x, index) => <mesh key={x} position={[x, 0.55 + (index % 2) * 0.15, -0.18]} rotation={[0, (index - 1.5) * 0.12, 0]}><boxGeometry args={[0.24, 0.82, 0.14]} /><meshStandardMaterial color={index % 2 ? "#9aa695" : "#78887d"} emissive={color} emissiveIntensity={activityActive ? 0.32 : 0.08} roughness={0.92} /></mesh>)}
    </group>
  );
  return (
    <group rotation={[0, ((stableIdHash(moduleId) % 90) * Math.PI) / 180, 0]}>
      {[0.88, 1.22].map((radius, index) => (
        <mesh key={radius} position={[0, 0.32 + index * 0.08, 0]} rotation={[-Math.PI / 2, index * 0.34, 0]}>
          <torusGeometry args={[radius, 0.025 + index * 0.012, 7, 42]} />
          {ringMaterial}
        </mesh>
      ))}
      {Array.from({ length: 5 }, (_, index) => {
        const angle = index * Math.PI * 2 / 5;
        return (
          <mesh key={index} position={[Math.cos(angle) * 1.28, 0.42, Math.sin(angle) * 1.28]} scale={[0.11, 0.22, 0.11]}>
            <octahedronGeometry args={[1, 0]} />
            {ringMaterial}
          </mesh>
        );
      })}
    </group>
  );
}

function RootPaths({ activeModuleIds, zonePositions, glowEnabled }: { activeModuleIds: string[]; zonePositions: ZonePositionMap; glowEnabled: boolean }) {
  const paths = useMemo(() => Object.entries(zonePositions).map(([moduleId, [x, , z]], index) => ({
    moduleId,
    curve: new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0.11, 0),
      new THREE.Vector3(x * 0.45 + Math.sin(index) * 0.5, 0.12, z * 0.45 + Math.cos(index) * 0.5),
      new THREE.Vector3(x, 0.14, z),
    ]),
  })), [zonePositions]);
  return (
    <group>
      {paths.map(({ moduleId, curve }) => {
        const active = activeModuleIds.includes(moduleId);
        return (
          <group key={moduleId}>
            <mesh><tubeGeometry args={[curve, 36, 0.075, 7, false]} /><meshStandardMaterial color="#7d684a" roughness={0.96} transparent opacity={0.7} /></mesh>
            {glowEnabled && <mesh position={[0, 0.03, 0]}><tubeGeometry args={[curve, 36, 0.018, 6, false]} /><meshStandardMaterial color={active ? "#ffe49a" : "#62b88e"} emissive={active ? "#ffd36b" : "#3a8d69"} emissiveIntensity={active ? 1.4 : 0.42} transparent opacity={active ? 0.92 : 0.5} /></mesh>}
          </group>
        );
      })}
    </group>
  );
}

function SanctuaryPlatform({
  color,
  stone,
  selected,
  activityActive,
  glowEnabled,
}: {
  color: string;
  stone: string;
  selected: boolean;
  activityActive: boolean;
  glowEnabled: boolean;
}) {
  const energy = selected ? 1.35 : activityActive ? 0.92 : 0.5;
  return (
    <group>
      <mesh position={[0, -0.16, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[1.02, 1.3, 0.34, 28]} />
        <meshStandardMaterial color={stone} roughness={0.96} metalness={0.04} />
      </mesh>
      <mesh position={[0, 0.045, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.82, 1.02, 0.24, 28]} />
        <meshStandardMaterial color="#89978a" roughness={0.88} metalness={0.06} />
      </mesh>
      <mesh position={[0, 0.18, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.72, 36]} />
        <meshPhysicalMaterial color="#4d7464" roughness={0.42} clearcoat={0.12} transparent opacity={0.72} />
      </mesh>
      {glowEnabled && <mesh position={[0, 0.196, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.56, 0.018, 7, 64]} />
        <meshBasicMaterial color={color} transparent opacity={0.78} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>}
      <mesh position={[0, -0.005, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <torusGeometry args={[1.11, 0.035, 7, 64]} />
        <meshStandardMaterial color="#b9c3a8" emissive={color} emissiveIntensity={glowEnabled ? 0.16 * energy : 0.02} roughness={0.75} />
      </mesh>
      {Array.from({ length: 4 }, (_, index) => {
        const angle = index * Math.PI / 2 + Math.PI / 4;
        const height = 0.28 + (index % 3) * 0.07;
        return (
          <group key={`rune-pillar-${index}`} position={[Math.cos(angle) * 0.96, 0.14, Math.sin(angle) * 0.96]} rotation={[0, -angle, 0]}>
            <mesh position={[0, height / 2, 0]} castShadow>
              <cylinderGeometry args={[0.055, 0.1, height, 6]} />
              <meshStandardMaterial color={index % 2 ? "#778579" : "#929b88"} roughness={0.94} />
            </mesh>
            <mesh position={[0, height + 0.055, 0]} rotation={[0, angle * 0.5, 0]}>
              <octahedronGeometry args={[0.075, 0]} />
              <meshStandardMaterial color={color} emissive={color} emissiveIntensity={glowEnabled ? energy : 0.04} roughness={0.35} />
            </mesh>
          </group>
        );
      })}
      {[0.35, 3.5].map((angle, index) => (
        <group key={`platform-moss-${index}`} position={[Math.cos(angle) * 1.04, 0.055, Math.sin(angle) * 1.04]} rotation={[0, -angle, 0]}>
          <mesh scale={[0.2 + index * 0.018, 0.08, 0.13]}>
            <dodecahedronGeometry args={[1, 0]} />
            <meshStandardMaterial color={index % 2 ? "#658650" : "#789657"} roughness={1} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

function Zone({
  module,
  position,
  locale,
  visualStyle,
  selected,
  activityActive,
  effects,
  onSelect,
}: {
  module: ModuleHealth;
  position: ZonePosition;
  locale: Locale;
  visualStyle: "detailed" | "simple";
  selected: boolean;
  activityActive: boolean;
  effects: ActiveVisualEffects;
  onSelect: () => void;
}) {
  const color = STATUS_COLORS[module.health.status] ?? STATUS_COLORS.unknown;
  const sanctuaryStone = {
    "seed-memory": "#707a5c", "seed-core": "#7b715d", brain: "#756f7f", hooks: "#667c75", evolution: "#80765c",
    roles: "#6e7980", resources: "#5f7a78", receipts: "#747a6e",
  }[module.id] ?? "#6f746b";
  const organ = useRef<THREE.Group>(null);
  const reducedMotion = useReducedMotion();
  useEffect(() => {
    if (!organ.current || effects.motion) return;
    organ.current.position.y = 0;
    organ.current.rotation.y = 0;
    organ.current.scale.setScalar(selected ? 1.42 : activityActive ? 1.12 : 1);
  }, [activityActive, effects.motion, selected]);
  useFrame(({ clock }, delta) => {
    if (!organ.current || reducedMotion || !effects.motion) return;
    organ.current.position.y = Math.sin(clock.elapsedTime * 0.72 + position[0]) * 0.055;
    organ.current.rotation.y = Math.sin(clock.elapsedTime * 0.38 + position[2]) * 0.045;
    const targetScale = selected ? 1.42 : activityActive ? 1.12 : 1;
    const scale = THREE.MathUtils.damp(organ.current.scale.x, targetScale, 7.5, delta);
    organ.current.scale.setScalar(scale);
  });
  return (
    <group
      position={position}
      userData={{ interactionPriority: INTERACTION_PRIORITY.foreground }}
      onClick={(event) => selectFromPointer(event, onSelect)}
      onPointerOver={() => { document.body.style.cursor = "pointer"; }}
      onPointerOut={() => { document.body.style.cursor = "default"; }}
    >
      <mesh position={[0, 1, 0]} scale={[1, 0.86, 1]}>
        <sphereGeometry args={[1.7, 16, 12]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} colorWrite={false} />
      </mesh>
      {visualStyle === "detailed" ? (
        <SanctuaryPlatform color={color} stone={sanctuaryStone} selected={selected} activityActive={activityActive} glowEnabled={effects.glow} />
      ) : (
        <mesh castShadow>
          <cylinderGeometry args={[0.78, 1.05, 0.55, 8]} />
          <meshPhysicalMaterial color="#4b8671" roughness={0.45} metalness={0.08} transparent opacity={0.86} />
        </mesh>
      )}
      {visualStyle === "detailed" && <OrganSanctuary moduleId={module.id} color={color} activityActive={activityActive} glowEnabled={effects.glow} />}
      <group ref={organ}>
        <OrganGlyph moduleId={module.id} color={color} detailed={visualStyle === "detailed"} />
      </group>
      <mesh position={[0, 0.38, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[selected ? 0.82 : 0.7, selected ? 0.94 : 0.8, 32]} />
        <meshBasicMaterial color={color} transparent opacity={selected ? 0.96 : 0.42} />
      </mesh>
      {effects.glow && selected && (
        <mesh position={[0, 0.4, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[1.02, 1.09, 40]} />
          <meshBasicMaterial color={color} transparent opacity={0.52} blending={THREE.AdditiveBlending} depthWrite={false} />
        </mesh>
      )}
      {effects.glow && activityActive && !selected && (
        <mesh position={[0, 0.4, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.92, 1.02, 40]} />
          <meshBasicMaterial color="#fff1a8" transparent opacity={0.66} blending={THREE.AdditiveBlending} depthWrite={false} />
        </mesh>
      )}
      <Html position={[0, 2.08, 0]} center distanceFactor={11} zIndexRange={[20, 0]}>
        <button
          className={`scene-label ${selected ? "is-selected" : ""}`}
          onPointerDown={stopProjectedLabelEvent}
          onPointerUp={stopProjectedLabelEvent}
          onClick={(event) => selectFromProjectedLabel(event, onSelect)}
        >
          <span className="status-dot" data-status={module.health.status} />
          {moduleName(locale, module.id, module.name)}
        </button>
      </Html>
    </group>
  );
}

function deriveLaboratoryPosition(zonePositions: ZonePositionMap): ZonePosition | undefined {
  const evolution = zonePositions.evolution;
  if (!evolution) return undefined;
  const radialLength = Math.hypot(evolution[0], evolution[2]) || 1;
  return [
    evolution[0] + (evolution[0] / radialLength) * LABORATORY_OFFSET,
    Math.max(0.08, evolution[1] - 0.16),
    evolution[2] + (evolution[2] / radialLength) * LABORATORY_OFFSET,
  ];
}

function DirectionMarker({
  curve,
  progress,
  color,
  reverse = false,
}: {
  curve: THREE.CatmullRomCurve3;
  progress: number;
  color: string;
  reverse?: boolean;
}) {
  const { position, quaternion } = useMemo(() => {
    const point = curve.getPointAt(progress);
    const tangent = curve.getTangentAt(progress).normalize().multiplyScalar(reverse ? -1 : 1);
    return {
      position: point,
      quaternion: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), tangent),
    };
  }, [curve, progress, reverse]);
  return (
    <mesh position={position} quaternion={quaternion}>
      <coneGeometry args={[0.095, 0.28, 7]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.72} roughness={0.38} />
    </mesh>
  );
}

function LaboratoryConnection({
  evolutionPosition,
  laboratoryPosition,
  locale,
  related,
  glowEnabled,
}: {
  evolutionPosition: ZonePosition;
  laboratoryPosition: ZonePosition;
  locale: Locale;
  related: boolean;
  glowEnabled: boolean;
}) {
  const { forward, returnPath, midpoint } = useMemo(() => {
    const start = new THREE.Vector3(...evolutionPosition).add(new THREE.Vector3(0, 0.62, 0));
    const end = new THREE.Vector3(...laboratoryPosition).add(new THREE.Vector3(0, 0.62, 0));
    const direction = end.clone().sub(start);
    const side = new THREE.Vector3(-direction.z, 0, direction.x).normalize().multiplyScalar(0.09);
    const center = start.clone().lerp(end, 0.5).add(new THREE.Vector3(0, 0.34, 0));
    return {
      forward: new THREE.CatmullRomCurve3([start.clone().add(side), center.clone().add(side), end.clone().add(side)]),
      returnPath: new THREE.CatmullRomCurve3([start.clone().sub(side), center.clone().sub(side), end.clone().sub(side)]),
      midpoint: center,
    };
  }, [evolutionPosition, laboratoryPosition]);
  const opacity = related ? 0.9 : 0.42;
  return (
    <group userData={{ interactionPriority: INTERACTION_PRIORITY.landmark }}>
      <mesh><tubeGeometry args={[forward, 28, related ? 0.035 : 0.026, 6, false]} /><meshStandardMaterial color="#e2c878" emissive="#b99842" emissiveIntensity={glowEnabled ? (related ? 0.9 : 0.35) : 0.04} transparent opacity={opacity} /></mesh>
      <mesh><tubeGeometry args={[returnPath, 28, related ? 0.035 : 0.026, 6, false]} /><meshStandardMaterial color="#74d6b0" emissive="#3b9d79" emissiveIntensity={glowEnabled ? (related ? 0.9 : 0.35) : 0.04} transparent opacity={opacity} /></mesh>
      <DirectionMarker curve={forward} progress={0.62} color="#e2c878" />
      <DirectionMarker curve={returnPath} progress={0.38} color="#74d6b0" reverse />
      <Html position={[midpoint.x, midpoint.y + 0.32, midpoint.z]} center distanceFactor={13} zIndexRange={[16, 0]}>
        <span className={`facility-link-label ${related ? "is-related" : ""}`}>{t(locale, "lab.scene_relationship")}</span>
      </Html>
    </group>
  );
}

function LaboratoryFacility({
  position,
  locale,
  visualStyle,
  selected,
  related,
  effects,
  onSelect,
}: {
  position: ZonePosition;
  locale: Locale;
  visualStyle: "detailed" | "simple";
  selected: boolean;
  related: boolean;
  effects: ActiveVisualEffects;
  onSelect: () => void;
}) {
  const detailed = visualStyle === "detailed";
  const glow = effects.glow ? (selected ? 1.15 : related ? 0.72 : 0.34) : 0.04;
  const pillars = detailed ? 8 : 4;
  return (
    <group
      position={position}
      userData={{ interactionPriority: INTERACTION_PRIORITY.foreground }}
      onClick={(event) => selectFromPointer(event, onSelect)}
      onPointerOver={() => { document.body.style.cursor = "pointer"; }}
      onPointerOut={() => { document.body.style.cursor = "default"; }}
    >
      <mesh position={[0, 1.08, 0]} scale={[1.15, 0.95, 1.15]}>
        <sphereGeometry args={[1.75, 16, 12]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} colorWrite={false} />
      </mesh>
      <mesh position={[0, -0.14, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[1.36, 1.58, 0.36, 12]} />
        <meshStandardMaterial color={detailed ? "#676d5f" : "#527466"} roughness={0.92} />
      </mesh>
      <mesh position={[0, 0.08, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[1.18, 1.34, 0.22, 12]} />
        <meshStandardMaterial color="#8b8a70" emissive="#8f7341" emissiveIntensity={0.08} roughness={0.84} />
      </mesh>
      {Array.from({ length: pillars }, (_, index) => {
        const angle = (index / pillars) * Math.PI * 2 + Math.PI / 8;
        return (
          <group key={index} position={[Math.cos(angle) * 0.94, 0.92, Math.sin(angle) * 0.94]}>
            <mesh castShadow><cylinderGeometry args={[0.06, 0.09, 1.58, 6]} /><meshStandardMaterial color="#70573b" roughness={0.82} /></mesh>
            {detailed && <mesh position={[0, 0.18, 0]} scale={[0.075, 0.46, 0.075]}><boxGeometry /><meshStandardMaterial color="#d6b86e" emissive="#b8913f" emissiveIntensity={glow * 0.45} /></mesh>}
          </group>
        );
      })}
      <mesh position={[0, 1.67, 0]} castShadow>
        <coneGeometry args={[1.28, 0.62, 8, 1, true]} />
        <meshPhysicalMaterial color="#99c8b8" transparent opacity={detailed ? 0.32 : 0.48} transmission={detailed ? 0.42 : 0.08} roughness={0.28} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0, 1.93, 0]}>
        <octahedronGeometry args={[0.17, 0]} />
        <meshStandardMaterial color="#f0d58b" emissive="#e2b954" emissiveIntensity={glow} roughness={0.3} />
      </mesh>
      <group position={[0, 0.72, 0]}>
        <mesh scale={[0.46, 0.36, 0.46]} castShadow>
          <sphereGeometry args={[0.62, detailed ? 18 : 10, detailed ? 14 : 8]} />
          <meshPhysicalMaterial color="#a8e7d0" transparent opacity={0.48} transmission={detailed ? 0.46 : 0.12} roughness={0.2} />
        </mesh>
        <mesh position={[0, 0.34, 0]}>
          <cylinderGeometry args={[0.12, 0.16, 0.48, 10]} />
          <meshPhysicalMaterial color="#d7f0e7" transparent opacity={0.56} roughness={0.18} />
        </mesh>
        <mesh position={[0, -0.08, 0]} scale={[0.34, 0.18, 0.34]}>
          <sphereGeometry args={[0.55, 12, 9]} />
          <meshStandardMaterial color="#ddc06c" emissive="#d9a941" emissiveIntensity={glow * 1.1} transparent opacity={0.86} />
        </mesh>
      </group>
      <mesh position={[0, 0.13, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[selected ? 1.28 : 1.16, selected ? 1.38 : 1.25, 40]} />
        <meshBasicMaterial color={selected ? "#ffe09a" : "#7fdfbd"} transparent opacity={selected ? 0.9 : 0.42} />
      </mesh>
      <Html position={[0, 2.45, 0]} center distanceFactor={11} zIndexRange={[20, 0]}>
        <button
          className={`scene-label facility-label ${selected ? "is-selected" : ""}`}
          aria-label={t(locale, "lab.title")}
          onPointerDown={stopProjectedLabelEvent}
          onPointerUp={stopProjectedLabelEvent}
          onClick={(event) => selectFromProjectedLabel(event, onSelect)}
        >
          <span className="facility-symbol" aria-hidden="true">⌬</span>
          {t(locale, "lab.title")}
        </button>
      </Html>
    </group>
  );
}

function connectionCurve(connection: CanopyConnection, zonePositions: ZonePositionMap): THREE.CatmullRomCurve3 {
  const source = new THREE.Vector3(...zonePositions[connection.source]).add(new THREE.Vector3(0, 0.95, 0));
  const target = new THREE.Vector3(...zonePositions[connection.target]).add(new THREE.Vector3(0, 0.95, 0));
  const midpoint = source.clone().lerp(target, 0.5);
  const direction = target.clone().sub(source);
  const perpendicular = new THREE.Vector3(-direction.z, 0, direction.x).normalize();
  const hash = Array.from(connection.id).reduce((total, character) => total + character.charCodeAt(0), 0);
  const phaseLift = connection.phase === "maintenance" ? 0.45 : connection.phase === "learning" ? 1.45 : 0.95;
  const bend = ((hash % 5) - 2) * 0.34;
  midpoint.add(perpendicular.multiplyScalar(bend));
  midpoint.y += phaseLift + (hash % 3) * 0.16;
  return new THREE.CatmullRomCurve3([source, midpoint, target], false, "catmullrom", 0.45);
}

function ConnectionArc({
  connection,
  zonePositions,
  selectedModuleId,
  locale,
  visualStyle,
  activityActive,
  flowEnabled,
  glowEnabled,
}: {
  connection: CanopyConnection;
  zonePositions: ZonePositionMap;
  selectedModuleId: string;
  locale: Locale;
  visualStyle: "detailed" | "simple";
  activityActive: boolean;
  flowEnabled: boolean;
  glowEnabled: boolean;
}) {
  const curve = useMemo(() => connectionCurve(connection, zonePositions), [connection, zonePositions]);
  const color = STATUS_COLORS[connection.health.status] ?? STATUS_COLORS.unknown;
  const adjacent = connection.source === selectedModuleId || connection.target === selectedModuleId;
  const detailed = visualStyle === "detailed";
  const coreRadius = adjacent ? (detailed ? 0.075 : 0.06) : (detailed ? 0.052 : 0.038);
  const glowRadius = adjacent ? (detailed ? 0.2 : 0.14) : (detailed ? 0.14 : 0.095);
  const reducedMotion = useReducedMotion();
  const signals = useRef<Array<THREE.Group | null>>([]);
  const arrival = useRef<THREE.Mesh>(null);
  const arrivalMaterial = useRef<THREE.MeshBasicMaterial>(null);
  const hashOffset = useMemo(
    () => Array.from(connection.id).reduce((total, character) => total + character.charCodeAt(0), 0) / 100,
    [connection.id],
  );
  const arrow = useMemo(() => {
    const position = curve.getPoint(0.74);
    const tangent = curve.getTangent(0.74).normalize();
    const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), tangent);
    return { position, quaternion };
  }, [curve]);
  const labelPosition = useMemo(() => curve.getPoint(0.5), [curve]);
  const targetPosition = useMemo(() => curve.getPoint(1), [curve]);
  const signalStartPositions = useMemo(
    () => Array.from({ length: detailed ? 3 : 2 }, (_, index) => curve.getPoint(0.2 + index * 0.45)),
    [curve, detailed],
  );

  useFrame(({ clock }) => {
    if (!flowEnabled) return;
    let absorption = 0;
    signals.current.forEach((signal, index) => {
      if (!signal) return;
      const offset = reducedMotion
        ? 0.25 + index * 0.38
        : (clock.elapsedTime * ((activityActive ? 0.09 : 0.055) + connection.signal.strength * 0.035) + hashOffset + index * 0.42) % 1;
      curve.getPoint(offset, signal.position);
      const arriving = offset > 0.82 ? (offset - 0.82) / 0.18 : 0;
      signal.scale.setScalar(1 - arriving * 0.84);
      absorption = Math.max(absorption, arriving);
    });
    if (arrival.current && arrivalMaterial.current) {
      const glow = Math.sin(absorption * Math.PI);
      arrival.current.scale.setScalar(0.15 + absorption * 2.7);
      arrivalMaterial.current.opacity = (adjacent ? 0.38 : 0.16) * glow;
    }
  });

  return (
    <group>
      <mesh>
        <tubeGeometry args={[curve, 56, coreRadius, detailed ? 9 : 7, false]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={glowEnabled ? (adjacent ? 0.72 : activityActive ? 0.66 : detailed ? 0.42 : 0.36) : 0.05}
          transparent
          opacity={adjacent ? 0.78 : activityActive ? 0.68 : detailed ? 0.5 : 0.4}
          roughness={0.38}
          depthTest={false}
          depthWrite={false}
        />
      </mesh>
      {glowEnabled && <mesh renderOrder={5}>
        <tubeGeometry args={[curve, 56, glowRadius, 8, false]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={adjacent ? 0.14 : detailed ? 0.075 : 0.06}
          blending={THREE.AdditiveBlending}
          depthTest={false}
          depthWrite={false}
        />
      </mesh>}
      <mesh position={arrow.position} quaternion={arrow.quaternion} renderOrder={7}>
        <coneGeometry args={[adjacent ? 0.115 : 0.08, adjacent ? 0.32 : 0.24, 8]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={glowEnabled ? (adjacent ? 1.1 : 0.55) : 0.05} transparent opacity={adjacent ? 0.94 : 0.58} depthTest={false} depthWrite={false} />
      </mesh>
      {flowEnabled && signalStartPositions.map((position, index) => (
        <group
          key={index}
          ref={(node) => { signals.current[index] = node; }}
          position={position}
        >
          <mesh renderOrder={8}>
            <sphereGeometry args={[adjacent ? 0.085 : 0.058, 12, 9]} />
            <meshBasicMaterial color="#f5fffb" transparent opacity={adjacent ? 1 : 0.82} blending={THREE.AdditiveBlending} depthTest={false} depthWrite={false} />
          </mesh>
          {glowEnabled && <mesh renderOrder={7}>
            <sphereGeometry args={[adjacent ? 0.23 : 0.15, 12, 9]} />
            <meshBasicMaterial color={color} transparent opacity={adjacent ? 0.3 : 0.16} blending={THREE.AdditiveBlending} depthTest={false} depthWrite={false} />
          </mesh>}
        </group>
      ))}
      {flowEnabled && glowEnabled && <mesh ref={arrival} position={targetPosition} scale={0.1}>
        <sphereGeometry args={[adjacent ? 0.3 : 0.2, 16, 12]} />
        <meshBasicMaterial
          ref={arrivalMaterial}
          color={color}
          transparent
          opacity={0}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>}
      {adjacent && (
        <Html position={labelPosition} center distanceFactor={12} zIndexRange={[15, 0]}>
          <span className="flow-label" data-phase={connection.phase}>{t(locale, connection.label_key)}</span>
        </Html>
      )}
    </group>
  );
}

function ConnectionNetwork({
  connections,
  zonePositions,
  selectedModuleId,
  locale,
  visualStyle,
  activeModuleIds,
  effects,
}: Pick<SceneProps, "connections" | "selectedModuleId" | "locale" | "activeModuleIds"> & {
  visualStyle: "detailed" | "simple";
  zonePositions: ZonePositionMap;
  effects: ActiveVisualEffects;
}) {
  return (
    <group>
      {connections.map((connection) => (
        <ConnectionArc
          key={connection.id}
          connection={connection}
          zonePositions={zonePositions}
          selectedModuleId={selectedModuleId}
          locale={locale}
          visualStyle={visualStyle}
          activityActive={activeModuleIds.includes(connection.source) || activeModuleIds.includes(connection.target)}
          flowEnabled={effects.flow}
          glowEnabled={effects.glow}
        />
      ))}
    </group>
  );
}

function RootNetwork({
  cards,
  selectedCardId,
  onSelectCard,
  locale,
  visualStyle,
  effects,
}: Pick<SceneProps, "cards" | "selectedCardId" | "onSelectCard" | "locale"> & {
  visualStyle: "detailed" | "simple";
  effects: ActiveVisualEffects;
}) {
  const visibleCards = useMemo(() => cards.filter((card) => card.lifecycle === "active").slice(0, 24), [cards]);
  const branchCount = visualStyle === "detailed" ? 18 : 8;
  const branches = useMemo(() => Array.from({ length: branchCount }, (_, index) => {
    const angle = (index / branchCount) * Math.PI * 2;
    if (visualStyle !== "detailed") return { angle, curve: null };
    const start = new THREE.Vector3(0, 0.02, 0);
    const middle = new THREE.Vector3(Math.cos(angle + 0.16) * 1.8, 0.04, Math.sin(angle + 0.16) * 1.8);
    const end = new THREE.Vector3(Math.cos(angle) * (4.2 + (index % 3) * 0.28), 0.02, Math.sin(angle) * (4.2 + (index % 3) * 0.28));
    return { angle, curve: new THREE.CatmullRomCurve3([start, middle, end]) };
  }), [branchCount, visualStyle]);
  return (
    <group position={[-3.8, -0.72, 0.5]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.05, 0]}>
        <circleGeometry args={[5.1, 48]} />
        <meshStandardMaterial color="#163d32" roughness={0.9} />
      </mesh>
      {branches.map(({ angle, curve }, index) => {
        if (curve) {
          return (
            <mesh key={index}>
              <tubeGeometry args={[curve, 28, index % 3 === 0 ? 0.075 : 0.045, 6, false]} />
              <meshStandardMaterial color={index % 2 ? "#a97a46" : "#c69a62"} emissive="#5c3d25" emissiveIntensity={0.32} />
            </mesh>
          );
        }
        return (
          <mesh key={index} rotation={[0, angle, Math.PI / 2]} position={[Math.cos(angle) * 1.9, 0.02, Math.sin(angle) * 1.9]}>
            <cylinderGeometry args={[0.035, 0.12, 4.2, 5]} />
            <meshStandardMaterial color="#b78b55" emissive="#6d4f2e" emissiveIntensity={0.45} />
          </mesh>
        );
      })}
      {visibleCards.map((card, index) => {
        const angle = (index / Math.max(visibleCards.length, 1)) * Math.PI * 2 + (index % 3) * 0.17;
        const radius = 1.55 + (index % 4) * 0.8;
        const selected = card.id === selectedCardId;
        const color = STATUS_COLORS[card.health.status] ?? STATUS_COLORS.unknown;
        return (
          <group key={card.id} position={[Math.cos(angle) * radius, 0.25 + (index % 3) * 0.14, Math.sin(angle) * radius]}>
            <mesh
              scale={selected ? 1.35 : 1}
              userData={{ interactionPriority: INTERACTION_PRIORITY.foreground }}
              onClick={(event) => selectFromPointer(event, () => onSelectCard(card.id))}
            >
              {visualStyle === "detailed" ? <dodecahedronGeometry args={[0.22, 0]} /> : <sphereGeometry args={[0.22, 12, 9]} />}
              <meshStandardMaterial color={color} emissive={color} emissiveIntensity={effects.glow ? (selected ? 1.5 : 0.55) : 0.05} />
            </mesh>
            {selected && (
              <Html position={[0, 0.62, 0]} center distanceFactor={8}>
                <button
                  className="scene-label is-selected"
                  onPointerDown={stopProjectedLabelEvent}
                  onPointerUp={stopProjectedLabelEvent}
                  onClick={(event) => selectFromProjectedLabel(event, () => onSelectCard(card.id))}
                >
                  {cardDisplayName(locale, card)}
                </button>
              </Html>
            )}
          </group>
        );
      })}
      {effects.particles && <Sparkles count={70} scale={[9, 1.4, 9]} size={1.5} speed={0.18} color="#ffd992" />}
    </group>
  );
}

function StructureGlyph({ node, module, selected }: { node: StructureNode; module?: ModuleHealth; selected: boolean }) {
  const color = module ? STATUS_COLORS[module.health.status] : node.kind === "component" ? "#8ed8c3" : "#79c99b";
  if (node.kind === "organ" && module) {
    return <group scale={selected ? 1.05 : 0.78}><OrganGlyph moduleId={module.id} color={color} detailed /></group>;
  }
  if (node.kind === "canopy") {
    return (
      <group>
        <mesh>
          <sphereGeometry args={[1.22, 24, 14, 0, Math.PI * 2, 0, Math.PI / 2]} />
          <meshPhysicalMaterial color="#aeeed8" wireframe transparent opacity={0.55} transmission={0.25} />
        </mesh>
        <mesh position={[0, 0.2, 0]}>
          <icosahedronGeometry args={[0.42, 1]} />
          <meshStandardMaterial color="#ffe08a" emissive="#79d8ad" emissiveIntensity={1.1} />
        </mesh>
      </group>
    );
  }
  if (node.kind === "landmark") {
    return (
      <group>
        <mesh position={[0, 0.45, 0]}>
          <cylinderGeometry args={[0.24, 0.45, 1.55, 7]} />
          <meshStandardMaterial color="#765137" roughness={0.9} />
        </mesh>
        {[[-0.55, 1.2, 0], [0.55, 1.35, 0], [0, 1.62, 0]].map(([x, y, z], index) => (
          <mesh key={index} position={[x, y, z]} scale={index === 2 ? 0.72 : 0.62}>
            <dodecahedronGeometry args={[0.72, 0]} />
            <meshStandardMaterial color={index === 2 ? "#8ccf62" : "#58aa67"} />
          </mesh>
        ))}
      </group>
    );
  }
  if (node.kind === "component") {
    return (
      <group rotation={[0, -0.24, 0]}>
        <mesh castShadow>
          <boxGeometry args={[1.15, 1.45, 0.14]} />
          <meshStandardMaterial color="#dff5ed" emissive={color} emissiveIntensity={selected ? 0.42 : 0.18} roughness={0.72} />
        </mesh>
        {[-0.35, -0.08, 0.19, 0.46].map((y, index) => (
          <mesh key={y} position={[-0.1, y, 0.09]}>
            <boxGeometry args={[index === 0 ? 0.65 : 0.78, 0.045, 0.02]} />
            <meshBasicMaterial color={index === 0 ? color : "#5e9280"} />
          </mesh>
        ))}
      </group>
    );
  }
  return (
    <group>
      <mesh position={[0, 0.15, 0]} castShadow>
        <cylinderGeometry args={[0.88, 1.05, 0.42, node.kind === "system" ? 8 : 6]} />
        <meshStandardMaterial color={node.kind === "system" ? "#788078" : "#667b70"} roughness={0.9} />
      </mesh>
      <mesh position={[0, 0.72, 0]} castShadow>
        {node.kind === "system" ? <octahedronGeometry args={[0.67, 0]} /> : <boxGeometry args={[1.02, 0.86, 0.86]} />}
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={selected ? 0.9 : 0.46} roughness={0.58} />
      </mesh>
      <mesh position={[0, 0.38, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.68, 0.78, 24]} />
        <meshBasicMaterial color="#c7f4df" transparent opacity={0.72} />
      </mesh>
    </group>
  );
}

function StructureBranch({ start, end, index, flowEnabled, glowEnabled }: { start: THREE.Vector3; end: THREE.Vector3; index: number; flowEnabled: boolean; glowEnabled: boolean }) {
  const curve = useMemo(() => {
    const midpoint = start.clone().lerp(end, 0.5);
    midpoint.y += 0.72 + (index % 3) * 0.16;
    return new THREE.CatmullRomCurve3([start, midpoint, end]);
  }, [end, index, start]);
  const signal = useRef<THREE.Mesh>(null);
  const reducedMotion = useReducedMotion();
  useFrame(({ clock }) => {
    if (!signal.current || !flowEnabled) return;
    const offset = reducedMotion ? 0.62 : (clock.elapsedTime * 0.12 + index * 0.17) % 1;
    curve.getPoint(offset, signal.current.position);
  });
  return (
    <group>
      <mesh renderOrder={4}>
        <tubeGeometry args={[curve, 28, 0.035, 6, false]} />
        <meshStandardMaterial color="#66dbae" emissive="#55d9a6" emissiveIntensity={glowEnabled ? 0.72 : 0.05} transparent opacity={0.58} depthWrite={false} />
      </mesh>
      {flowEnabled && <mesh ref={signal} renderOrder={7}>
        <sphereGeometry args={[0.075, 10, 8]} />
        <meshBasicMaterial color="#f5fff9" blending={THREE.AdditiveBlending} depthTest={false} />
      </mesh>}
    </group>
  );
}

function StructureNetwork({
  structure,
  modules,
  selectedId,
  locale,
  onSelect,
  effects,
}: {
  structure: CanopyStructure;
  modules: ModuleHealth[];
  selectedId: string;
  locale: Locale;
  onSelect: (nodeId: string) => void;
  effects: ActiveVisualEffects;
}) {
  const selected = structure.nodes.find((node) => node.id === selectedId) ?? structure.nodes.find((node) => node.id === structure.root_id);
  const children = selected ? structure.nodes.filter((node) => node.parent_id === selected.id) : [];
  const visible = children.slice(0, 20);
  const moduleIndex = useMemo(() => new Map(modules.map((module) => [module.id, module])), [modules]);
  const childPositions = useMemo(() => Array.from({ length: visible.length }, (_, index) => {
    const ring = index < 9 ? 0 : 1;
    const ringItems = ring === 0 ? Math.min(visible.length, 9) : visible.length - 9;
    const ringIndex = ring === 0 ? index : index - 9;
    const angle = (ringIndex / Math.max(ringItems, 1)) * Math.PI * 2 - Math.PI / 2;
    const radius = ring === 0 ? 3.45 : 5.4;
    return new THREE.Vector3(Math.cos(angle) * radius, ring === 0 ? 0.55 : 0.25, Math.sin(angle) * radius);
  }), [visible.length]);
  const center = useMemo(() => new THREE.Vector3(0, 1.05, 0), []);
  if (!selected) return null;
  return (
    <group>
      <mesh position={[0, -0.08, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[6.4, 64]} />
        <meshStandardMaterial color="#1c3b31" roughness={0.98} transparent opacity={0.82} />
      </mesh>
      <mesh position={[0, -0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[2.15, 2.25, 48]} />
        <meshStandardMaterial color="#77d8ae" emissive="#45bb8b" emissiveIntensity={0.72} transparent opacity={0.72} />
      </mesh>
      <group position={center} scale={1.28}>
        <StructureGlyph node={selected} module={moduleIndex.get(selected.module_id)} selected />
        <Html position={[0, 2.25, 0]} center distanceFactor={9} zIndexRange={[22, 0]}>
          <button
            className="structure-node-label is-current"
            onPointerDown={stopProjectedLabelEvent}
            onPointerUp={stopProjectedLabelEvent}
            onClick={(event) => selectFromProjectedLabel(event, () => onSelect(selected.id))}
          >
            <strong>{structureDisplayName(locale, selected)}</strong><small>{t(locale, `structure.kind.${selected.kind}`)} · {t(locale, "structure.child_count", { count: selected.child_count })}</small>
          </button>
        </Html>
      </group>
      {visible.map((node, index) => {
        const position = childPositions[index];
        return (
          <group key={node.id}>
            <StructureBranch start={center} end={position} index={index} flowEnabled={effects.flow} glowEnabled={effects.glow} />
            <group
              position={position}
              scale={node.kind === "component" ? 0.72 : 0.82}
              userData={{ interactionPriority: INTERACTION_PRIORITY.foreground }}
              onClick={(event) => selectFromPointer(event, () => onSelect(node.id))}
              onPointerOver={() => { document.body.style.cursor = "pointer"; }}
              onPointerOut={() => { document.body.style.cursor = "default"; }}
            >
              <StructureGlyph node={node} module={moduleIndex.get(node.module_id)} selected={false} />
              <Html position={[0, 1.85, 0]} center distanceFactor={10} zIndexRange={[20, 0]}>
                <button
                  className="structure-node-label"
                  onPointerDown={stopProjectedLabelEvent}
                  onPointerUp={stopProjectedLabelEvent}
                  onClick={(event) => selectFromProjectedLabel(event, () => onSelect(node.id))}
                >
                  <strong>{structureDisplayName(locale, node)}</strong><small>{t(locale, `structure.kind.${node.kind}`)}</small>
                </button>
              </Html>
            </group>
          </group>
        );
      })}
      {children.length > visible.length && (
        <Html position={[0, 0.2, 5.9]} center distanceFactor={10}>
          <span className="structure-overflow">+{children.length - visible.length}</span>
        </Html>
      )}
      {effects.particles && <Sparkles count={45} scale={[12, 4, 12]} size={1.4} speed={0.16} color="#8debc3" />}
    </group>
  );
}

function World(props: SceneProps & { cameraPanCommand: CameraPanCommand }) {
  const visualStyle = props.backgroundMode === "detailed" ? "detailed" : "simple";
  const detailedWorld = props.backgroundMode === "detailed";
  const reducedMotion = useReducedMotion();
  const effects = useMemo<ActiveVisualEffects>(() => ({
    particles: props.visualEffects.master && props.visualEffects.particles,
    flow: props.visualEffects.master && props.visualEffects.flow,
    clouds: props.visualEffects.master && props.visualEffects.clouds,
    glow: props.visualEffects.master && props.visualEffects.glow,
    motion: props.visualEffects.master && props.visualEffects.motion,
  }), [props.visualEffects]);
  const idleAnimationActive = !reducedMotion && (effects.particles || effects.flow || effects.motion);
  const zonePositions = useMemo(() => buildZonePositions(props.modules), [props.modules]);
  const laboratoryPosition = useMemo(() => deriveLaboratoryPosition(zonePositions), [zonePositions]);
  const overviewScene = props.view === "overview" || props.view === "laboratory";
  const laboratoryRelated = props.view === "laboratory" || props.selectedModuleId === "evolution";
  const { camera, gl, invalidate, setDpr, size } = useThree();
  const narrowViewport = size.width / Math.max(size.height, 1) < 0.72;
  const restingDpr = Math.min(
    window.devicePixelRatio || 1,
    idleAnimationActive ? (detailedWorld ? 1.25 : 1.15) : (detailedWorld ? 1.55 : 1.35),
  );
  const shadowRevision = [
    props.backgroundMode,
    effects.glow ? "glow" : "no-glow",
    props.view,
    props.selectedModuleId,
    props.selectedCardId,
    props.selectedStructureId,
    Math.round(props.growthProgress * 100),
    Math.round(Math.log2(1 + Math.max(0, props.growthEvidence)) * 10),
  ].join(":");
  const controlsRef = useRef<OrbitControlsImpl>(null);
  const effectDistance = useRef<EffectDistance>("far");
  const dprRestoreTimer = useRef<number | undefined>(undefined);
  const initialDprSync = useRef(true);
  const appliedCameraPanRevision = useRef(0);
  const interactionOrigin = useRef<{ camera: THREE.Vector3; target: THREE.Vector3 } | null>(null);
  const interactionClosedPanel = useRef(false);
  useEffect(() => {
    window.clearTimeout(dprRestoreTimer.current);
    if (initialDprSync.current) {
      initialDprSync.current = false;
      setDpr(restingDpr);
      return () => window.clearTimeout(dprRestoreTimer.current);
    }
    // Canvas initializes the new world at its upper DPR bound. Applying the
    // animation budget on the following frame makes the lower moving-scene
    // density reliable even when local preferences change across a reload.
    const syncFrame = window.requestAnimationFrame(() => setDpr(restingDpr));
    return () => {
      window.cancelAnimationFrame(syncFrame);
      window.clearTimeout(dprRestoreTimer.current);
    };
  }, [restingDpr, setDpr]);
  useEffect(() => {
    const surface = gl.domElement;
    const lowerDpr = () => {
      window.clearTimeout(dprRestoreTimer.current);
      setDpr(1);
    };
    const restoreDpr = () => {
      window.clearTimeout(dprRestoreTimer.current);
      dprRestoreTimer.current = window.setTimeout(() => setDpr(restingDpr), 180);
    };
    const lowerForWheel = () => {
      lowerDpr();
      restoreDpr();
    };
    surface.addEventListener("pointerdown", lowerDpr, { passive: true });
    surface.addEventListener("pointercancel", restoreDpr, { passive: true });
    surface.addEventListener("wheel", lowerForWheel, { passive: true });
    window.addEventListener("pointerup", restoreDpr, { passive: true });
    return () => {
      surface.removeEventListener("pointerdown", lowerDpr);
      surface.removeEventListener("pointercancel", restoreDpr);
      surface.removeEventListener("wheel", lowerForWheel);
      window.removeEventListener("pointerup", restoreDpr);
      window.clearTimeout(dprRestoreTimer.current);
    };
  }, [gl, restingDpr, setDpr]);
  useFrame(({ camera }) => {
    const controls = controlsRef.current;
    if (!controls) return;
    const distance = camera.position.distanceTo(controls.target);
    const current = effectDistance.current;
    // Separate enter/leave thresholds prevent a wheel resting on the boundary
    // from rapidly swapping the near and far effects.
    const next = current === "near"
      ? (distance >= 13 ? "far" : "near")
      : (distance <= 11 ? "near" : "far");
    if (next === current) return;
    effectDistance.current = next;
    props.onEffectDistanceChange(next);
  });
  useEffect(() => {
    const command = props.cameraPanCommand;
    const controls = controlsRef.current;
    if (!controls || command.revision <= appliedCameraPanRevision.current) return;

    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    right.y = 0;
    if (right.lengthSq() < 0.0001) right.set(1, 0, 0);
    const panStep = THREE.MathUtils.clamp(camera.position.distanceTo(controls.target) * 0.075, 0.55, 1.4);
    right.normalize().multiplyScalar(command.direction * panStep);

    const nextTarget = controls.target.clone().add(right);
    const planarTarget = new THREE.Vector2(nextTarget.x, nextTarget.z);
    if (planarTarget.length() > MAX_CAMERA_PAN_RADIUS) {
      planarTarget.setLength(MAX_CAMERA_PAN_RADIUS);
      nextTarget.x = planarTarget.x;
      nextTarget.z = planarTarget.y;
    }
    const appliedMovement = nextTarget.sub(controls.target);
    camera.position.add(appliedMovement);
    controls.target.add(appliedMovement);
    controls.update();
    appliedCameraPanRevision.current = command.revision;
    props.onSceneInteraction();
    invalidate();
  }, [camera, invalidate, props.cameraPanCommand, props.onSceneInteraction]);
  function beginSceneInteraction() {
    const controls = controlsRef.current;
    if (!controls) return;
    interactionOrigin.current = {
      camera: controls.object.position.clone(),
      target: controls.target.clone(),
    };
    interactionClosedPanel.current = false;
    window.clearTimeout(dprRestoreTimer.current);
    setDpr(1);
  }
  function observeSceneInteraction() {
    const controls = controlsRef.current;
    const origin = interactionOrigin.current;
    if (!controls || !origin || interactionClosedPanel.current) return;
    const moved = controls.object.position.distanceTo(origin.camera) > 0.045
      || controls.target.distanceTo(origin.target) > 0.045;
    if (moved) {
      interactionClosedPanel.current = true;
      props.onSceneInteraction();
    }
  }
  function endSceneInteraction() {
    interactionOrigin.current = null;
    window.clearTimeout(dprRestoreTimer.current);
    dprRestoreTimer.current = window.setTimeout(() => setDpr(restingDpr), 180);
  }
  return (
    <>
      <SceneRenderBudget shadowRevision={shadowRevision} active={idleAnimationActive} />
      <fog attach="fog" args={[detailedWorld ? "#426756" : "#bfe4d5", narrowViewport ? 50 : detailedWorld ? 30 : 22, narrowViewport ? 80 : detailedWorld ? 58 : 42]} />
      <ambientLight intensity={detailedWorld ? 0.58 : 0.86} />
      <hemisphereLight args={[detailedWorld ? "#d9f2e8" : "#d9f8ff", detailedWorld ? "#183f30" : "#22543d", detailedWorld ? 0.96 : 1.45]} />
      <directionalLight position={[6, 12, 7]} intensity={detailedWorld ? 1.55 : 2.15} color="#fff1c7" castShadow shadow-mapSize={[1024, 1024]} />
      <CameraRig
        view={props.view}
        selectedModuleId={props.selectedModuleId}
        focusRevision={props.focusRevision}
        cameraPanRevision={props.cameraPanCommand.revision}
        controlsRef={controlsRef}
        zonePositions={zonePositions}
        laboratoryPosition={laboratoryPosition}
      />
      {props.backgroundMode !== "none" && props.view !== "structure" && (
        <>
          {props.backgroundMode === "detailed" && <Ground />}
          {props.backgroundMode === "detailed" && <AncientRuins glowEnabled={effects.glow} />}
          <Dome visualStyle={visualStyle} locale={props.locale} onSelect={() => props.onSelectStructure("canopy-shell")} />
          <Tree visualStyle={visualStyle} locale={props.locale} growthProgress={props.growthProgress} growthEvidence={props.growthEvidence} effects={effects} onSelect={() => props.onSelectStructure("growth-tree")} />
          {props.backgroundMode === "detailed" && effects.glow && (
            <group position={[0, 5.05, -0.2]}>
              <mesh>
                <icosahedronGeometry args={[0.5, 2]} />
                <meshPhysicalMaterial color="#ffe08a" emissive="#ffc85e" emissiveIntensity={1.1} transparent opacity={0.34} roughness={0.12} transmission={0.38} />
              </mesh>
              <mesh scale={1.45}>
                <icosahedronGeometry args={[0.5, 1]} />
                <meshBasicMaterial color="#8bf0c6" wireframe transparent opacity={0.46} />
              </mesh>
              <pointLight color="#ffd36b" intensity={12} distance={8} />
            </group>
          )}
          {effects.particles && <Sparkles
            count={detailedWorld ? 58 : 18}
            position={[0, 6.4, -1.5]}
            scale={detailedWorld ? [19, 11, 19] : [13, 7, 13]}
            size={detailedWorld ? 1.05 : 1.2}
            speed={reducedMotion ? 0 : detailedWorld ? 0.07 : 0.04}
            color="#fff1b8"
          />}
        </>
      )}
      {overviewScene && (
        <>{props.backgroundMode === "detailed" && <RootPaths activeModuleIds={props.activeModuleIds} zonePositions={zonePositions} glowEnabled={effects.glow} />}</>
      )}
      {overviewScene && (
        <ConnectionNetwork
          connections={props.connections}
          zonePositions={zonePositions}
          selectedModuleId={props.selectedModuleId}
          locale={props.locale}
          visualStyle={visualStyle}
          activeModuleIds={props.activeModuleIds}
          effects={effects}
        />
      )}
      {overviewScene && props.modules.map((module) => (
        <Zone
          key={module.id}
          module={module}
          position={zonePositions[module.id]}
          locale={props.locale}
          visualStyle={visualStyle}
          selected={module.id === props.selectedModuleId || (props.view === "laboratory" && module.id === "evolution")}
          activityActive={props.activeModuleIds.includes(module.id)}
          effects={effects}
          onSelect={() => props.onSelectModule(module.id)}
        />
      ))}
      {overviewScene && laboratoryPosition && zonePositions.evolution && (
        <>
          <LaboratoryConnection
            evolutionPosition={zonePositions.evolution}
            laboratoryPosition={laboratoryPosition}
            locale={props.locale}
            related={laboratoryRelated}
            glowEnabled={effects.glow}
          />
          <LaboratoryFacility
            position={laboratoryPosition}
            locale={props.locale}
            visualStyle={visualStyle}
            selected={props.view === "laboratory"}
            related={laboratoryRelated}
            effects={effects}
            onSelect={props.onSelectLaboratory}
          />
        </>
      )}
      {props.view === "seed" && (
        <RootNetwork
          cards={props.cards}
          selectedCardId={props.selectedCardId}
          onSelectCard={props.onSelectCard}
          locale={props.locale}
          visualStyle={visualStyle}
          effects={effects}
        />
      )}
      {props.view === "structure" && props.structure && (
        <StructureNetwork
          structure={props.structure}
          modules={props.modules}
          selectedId={props.selectedStructureId}
          locale={props.locale}
          onSelect={props.onSelectStructure}
          effects={effects}
        />
      )}
      <OrbitControls
        ref={controlsRef}
        enablePan
        screenSpacePanning
        enableDamping={idleAnimationActive}
        dampingFactor={0.08}
        zoomSpeed={0.8}
        minDistance={4.8}
        maxDistance={narrowViewport ? 48 : 24}
        minPolarAngle={0.42}
        maxPolarAngle={Math.PI / 2.05}
        target={props.view === "seed"
          ? [-3.8, -0.5, 0.5]
          : props.view === "structure"
            ? [0, 1.05, 0]
            : props.view === "laboratory" && laboratoryPosition
              ? [laboratoryPosition[0], laboratoryPosition[1] + 1.05, laboratoryPosition[2]]
              : [0, 1.2, 0]}
        onStart={beginSceneInteraction}
        onChange={observeSceneInteraction}
        onEnd={endSceneInteraction}
      />
    </>
  );
}

export function CanopyScene(props: SceneProps) {
  const [cameraPanCommand, setCameraPanCommand] = useState<CameraPanCommand>({ direction: 1, revision: 0 });
  const requestCameraPan = useCallback((direction: CameraPanDirection) => {
    setCameraPanCommand((current) => ({ direction, revision: current.revision + 1 }));
  }, []);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("input, textarea, select, button, [contenteditable='true']")) return;
      const shell = document.querySelector<HTMLElement>(".app-shell");
      if (shell?.dataset.settings === "open" || shell?.dataset.view === "timeline") return;
      event.preventDefault();
      requestCameraPan(event.key === "ArrowLeft" ? -1 : 1);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [requestCameraPan]);
  const canvasAnimationActive = props.visualEffects.master && (
    props.visualEffects.particles
    || props.visualEffects.flow
    || props.visualEffects.motion
  );
  const maximumDpr = canvasAnimationActive
    ? (props.backgroundMode === "detailed" ? 1.25 : 1.15)
    : (props.backgroundMode === "detailed" ? 1.55 : 1.35);
  return (
    <>
      <Canvas
        className="canopy-canvas"
        data-render-policy={canvasAnimationActive ? "adaptive-idle-10" : "interaction-only"}
        data-animation-budget-fps={canvasAnimationActive ? "10" : "0"}
        data-shadow-policy="state-driven"
        data-interaction-dpr-policy="temporary-1x"
        frameloop="demand"
        shadows
        dpr={[1, maximumDpr]}
        camera={{ position: [0, 8.4, 18.8], fov: 43, near: 0.1, far: 80 }}
        gl={{ antialias: true, powerPreference: "default", alpha: true }}
        events={(state) => ({
          ...createPointerEvents(state),
          filter: prioritizeIntersections,
        })}
      >
        <World {...props} cameraPanCommand={cameraPanCommand} />
      </Canvas>
      <div className="camera-pan-controls" role="group" aria-label={t(props.locale, "camera.controls")}>
        <button
          type="button"
          aria-label={t(props.locale, "camera.left")}
          aria-keyshortcuts="ArrowLeft"
          title={t(props.locale, "camera.left")}
          onClick={() => requestCameraPan(-1)}
        >
          <ArrowLeft size={17} />
        </button>
        <span aria-hidden="true">{t(props.locale, "camera.pan")}</span>
        <button
          type="button"
          aria-label={t(props.locale, "camera.right")}
          aria-keyshortcuts="ArrowRight"
          title={t(props.locale, "camera.right")}
          onClick={() => requestCameraPan(1)}
        >
          <ArrowRight size={17} />
        </button>
      </div>
    </>
  );
}
