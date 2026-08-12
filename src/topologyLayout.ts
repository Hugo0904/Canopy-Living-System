import type { ModuleHealth } from "./types";


export type ZonePosition = [number, number, number];
export type ZonePositionMap = Record<string, ZonePosition>;

// Stable anchors preserve the curated architecture. New public module IDs are
// placed automatically instead of sharing a hard-coded fallback coordinate.
const KNOWN_ZONE_POSITIONS: ZonePositionMap = {
  "seed-memory": [-5.4, 0.2, 2.8],
  "seed-core": [-4.65, 0.45, 5.35],
  brain: [-1.8, 0.75, 5.15],
  roles: [-5.25, 0.2, -2.85],
  hooks: [1.35, 0.25, 3.0],
  receipts: [5.35, 0.25, 0],
  evolution: [4.75, 0.35, -3.25],
  resources: [0, 0.1, -5.3],
};

export function stableIdHash(identifier: string): number {
  return Array.from(identifier).reduce(
    (hash, character) => Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0,
    2166136261,
  );
}

export function buildZonePositions(modules: ModuleHealth[]): ZonePositionMap {
  const positions: ZonePositionMap = {};
  modules.forEach((module) => {
    const known = KNOWN_ZONE_POSITIONS[module.id];
    if (known) positions[module.id] = known;
  });

  const unknown = modules
    .filter((module) => !KNOWN_ZONE_POSITIONS[module.id])
    .sort((left, right) => left.id.localeCompare(right.id));
  unknown.forEach((module, index) => {
    const ring = Math.floor(index / 10);
    const radius = 7.15 + ring * 1.65;
    const hash = stableIdHash(module.id);
    let angle = 0.72 + index * 2.3999632297 + ((hash % 23) - 11) * 0.012;
    let candidate: ZonePosition = [Math.cos(angle) * radius, 0.18 + (hash % 4) * 0.11, Math.sin(angle) * radius];
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const clear = Object.values(positions).every(([x, , z]) => (
        Math.hypot(candidate[0] - x, candidate[2] - z) >= 2.65
      ));
      if (clear) break;
      angle += 0.37;
      candidate = [Math.cos(angle) * radius, candidate[1], Math.sin(angle) * radius];
    }
    positions[module.id] = candidate;
  });
  return positions;
}
