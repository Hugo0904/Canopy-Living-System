import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  BookOpen,
  ChevronUp,
  Clock3,
  ExternalLink,
  EyeOff,
  LoaderCircle,
  Search,
  Send,
  Stethoscope,
} from "lucide-react";
import type { FuraGuidanceAction, FuraGuidanceMessage } from "../types";
import "./FuraCompanion.css";

export type FuraPose =
  | "neutral"
  | "breathe"
  | "walk-left"
  | "walk-right"
  | "sit"
  | "stretch"
  | "exercise"
  | "notebook";

export interface FuraCompanionLabels {
  name: string;
  character: string;
  guidance: string;
  expandGuidance: string;
  collapseGuidance: string;
  openNotebook: string;
  dragHint: string;
  inspect: string;
  diagnose: string;
  snooze: string;
  dismiss: string;
  openSource: string;
  answerLabel: string;
  answerBoundary: string;
  answerPlaceholder: string;
  sendAnswer: string;
  sendingAnswer: string;
}

export interface FuraCompanionProps {
  message: FuraGuidanceMessage | null;
  motionEnabled: boolean;
  notebookOpen?: boolean;
  hidden?: boolean;
  suspended?: boolean;
  rightInset?: number;
  bottomInset?: number;
  busy?: boolean;
  labels?: Partial<FuraCompanionLabels>;
  spriteUrl?: string;
  className?: string;
  onOpenNotebook: () => void;
  onInspectReason?: (message: FuraGuidanceMessage) => void;
  onStartDiagnosis?: (message: FuraGuidanceMessage) => void;
  onSnooze?: (message: FuraGuidanceMessage) => void | Promise<void>;
  onDismiss?: (message: FuraGuidanceMessage) => void | Promise<void>;
  onOpenSource?: (message: FuraGuidanceMessage) => void;
  onAnswer?: (message: FuraGuidanceMessage, answer: string) => void | Promise<void>;
}

const DEFAULT_LABELS: FuraCompanionLabels = {
  name: "芙拉",
  character: "芙拉，神木的小精靈",
  guidance: "芙拉的訊息",
  expandGuidance: "展開芙拉的訊息",
  collapseGuidance: "收合芙拉的訊息",
  openNotebook: "打開芙拉的記事本",
  dragHint: "拖曳可以移動芙拉；短按可打開記事本",
  inspect: "查看原因",
  diagnose: "開始診斷",
  snooze: "稍後提醒",
  dismiss: "這次先不做",
  openSource: "查看來源",
  answerLabel: "你的回答",
  answerBoundary: "回答會保存為使用者明確提供的內容；AI 推論仍是候選，不會冒充你的原話。",
  answerPlaceholder: "把你的想法告訴芙拉…",
  sendAnswer: "送出回答",
  sendingAnswer: "正在保存回答",
};

const POSE_FRAME: Record<FuraPose, { column: number; row: number }> = {
  neutral: { column: 0, row: 0 },
  breathe: { column: 1, row: 0 },
  "walk-right": { column: 0, row: 1 },
  "walk-left": { column: 0, row: 2 },
  sit: { column: 0, row: 3 },
  stretch: { column: 1, row: 3 },
  exercise: { column: 2, row: 3 },
  notebook: { column: 3, row: 3 },
};

type FuraSequencePose = FuraPose | "walk-out" | "walk-back";

interface FuraMotionStep {
  pose: FuraSequencePose;
  duration: number;
  offset?: { x: number; y: number };
}

const MOTION_SEQUENCES: FuraMotionStep[][] = [
  [
    { pose: "walk-out", duration: 620, offset: { x: 14, y: -18 } },
    { pose: "walk-out", duration: 680, offset: { x: 36, y: -46 } },
    { pose: "walk-out", duration: 720, offset: { x: 58, y: -62 } },
    { pose: "sit", duration: 1250, offset: { x: 58, y: -62 } },
    { pose: "walk-back", duration: 680, offset: { x: 34, y: -42 } },
    { pose: "walk-back", duration: 650, offset: { x: 14, y: -18 } },
    { pose: "neutral", duration: 620, offset: { x: 0, y: 0 } },
  ],
  [
    { pose: "exercise", duration: 700, offset: { x: 8, y: -10 } },
    { pose: "neutral", duration: 480, offset: { x: 0, y: -5 } },
    { pose: "exercise", duration: 700, offset: { x: 12, y: -14 } },
    { pose: "neutral", duration: 720, offset: { x: 0, y: 0 } },
  ],
  [
    { pose: "stretch", duration: 1450, offset: { x: 5, y: -8 } },
    { pose: "neutral", duration: 800, offset: { x: 0, y: 0 } },
  ],
  [
    { pose: "sit", duration: 1850, offset: { x: 0, y: 5 } },
    { pose: "neutral", duration: 720, offset: { x: 0, y: 0 } },
  ],
  [
    { pose: "breathe", duration: 1050, offset: { x: -5, y: -5 } },
    { pose: "neutral", duration: 720, offset: { x: 0, y: 0 } },
    { pose: "breathe", duration: 1050, offset: { x: 5, y: -5 } },
    { pose: "neutral", duration: 720, offset: { x: 0, y: 0 } },
  ],
];

interface FuraPoint {
  x: number;
  y: number;
}

interface FuraViewport {
  width: number;
  height: number;
}

interface FuraDragState {
  pointerId: number;
  pointerX: number;
  pointerY: number;
  parkedOrigin: FuraPoint;
  origin: FuraPoint;
  latest: FuraPoint;
  moved: boolean;
}

const FURA_POSITION_STORAGE_KEY = "canopy.fura.position.v1";
const FURA_DRAG_THRESHOLD = 8;

function currentViewport(): FuraViewport {
  return {
    width: typeof window === "undefined" ? 1280 : window.innerWidth,
    height: typeof window === "undefined" ? 720 : window.innerHeight,
  };
}

function furaCharacterSize(viewport: FuraViewport): number {
  return viewport.width <= 700 ? 108 : 156;
}

function defaultFuraPosition(viewport: FuraViewport, bottomInset?: number): FuraPoint {
  const size = furaCharacterSize(viewport);
  const right = viewport.width <= 700 ? 9 : 22;
  const bottom = bottomInset ?? (viewport.width <= 700 ? 72 : 78);
  return {
    x: viewport.width - size - right,
    y: viewport.height - size - bottom,
  };
}

function readStoredFuraPosition(): FuraPoint | null {
  if (typeof window === "undefined") return null;
  try {
    const value = JSON.parse(window.localStorage.getItem(FURA_POSITION_STORAGE_KEY) || "null") as Partial<FuraPoint> | null;
    if (
      value
      && typeof value.x === "number"
      && typeof value.y === "number"
      && value.x >= 0
      && value.x <= 1
      && value.y >= 0
      && value.y <= 1
    ) return { x: value.x, y: value.y };
  } catch {
    // A malformed local preference is discarded; it is never a Core state.
  }
  return null;
}

function positionFromRatio(ratio: FuraPoint, viewport: FuraViewport): FuraPoint {
  const size = furaCharacterSize(viewport);
  return {
    x: ratio.x * viewport.width - size / 2,
    y: ratio.y * viewport.height - size / 2,
  };
}

function clampFuraPosition(
  position: FuraPoint,
  viewport: FuraViewport,
  rightInset = 0,
  bottomInset?: number,
): FuraPoint {
  const size = furaCharacterSize(viewport);
  const minimumTop = viewport.width <= 560 ? 136 : 76;
  const bottom = bottomInset ?? (viewport.width <= 700 ? 72 : 78);
  const maximumX = Math.max(10, viewport.width - size - 10 - Math.max(0, rightInset));
  const maximumY = Math.max(minimumTop, viewport.height - size - bottom);
  return {
    x: Math.min(maximumX, Math.max(10, position.x)),
    y: Math.min(maximumY, Math.max(minimumTop, position.y)),
  };
}

function rectanglesIntersect(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
): boolean {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

function visibleAvoidanceRectangles(): Array<{ x: number; y: number; width: number; height: number }> {
  if (typeof document === "undefined") return [];
  const selectors = [
    ".top-hud",
    ".topology-projection-badge",
    ".left-dock",
    ".bottom-hud",
    ".camera-pan-controls",
    ".observation-banner",
    ".seed-navigator",
    ".structure-breadcrumb",
    ".toast-sync",
    ".toast-error",
  ];
  return selectors.flatMap((selector) => [...document.querySelectorAll<HTMLElement>(selector)])
    .filter((element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
    })
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
}

function visibleFuraRoamObstacles(): ReturnType<typeof visibleAvoidanceRectangles> {
  const obstacles = visibleAvoidanceRectangles();
  if (typeof document === "undefined") return obstacles;
  const companion = document.querySelector<HTMLElement>(".fura-companion");
  // A collapsed speech bubble is attached to Fura and follows the same
  // transform, so it must not be treated as a separate obstacle that blocks
  // every walking path. Expanded speech pauses her below for comfortable
  // reading and can remain part of the avoidance map.
  if (companion?.dataset.guidanceExpanded === "false") return obstacles;
  const guidance = document.querySelector<HTMLElement>(".fura-guidance");
  if (!guidance) return obstacles;
  const style = window.getComputedStyle(guidance);
  const rect = guidance.getBoundingClientRect();
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) <= 0 || rect.width <= 0 || rect.height <= 0) {
    return obstacles;
  }
  return [...obstacles, { x: rect.x, y: rect.y, width: rect.width, height: rect.height }];
}

function rectangleClear(
  candidate: { x: number; y: number; width: number; height: number },
  obstacles: Array<{ x: number; y: number; width: number; height: number }>,
): boolean {
  return !obstacles.some((obstacle) => rectanglesIntersect(candidate, obstacle));
}

function furaPathClear(
  start: FuraPoint,
  end: FuraPoint,
  size: number,
  obstacles: Array<{ x: number; y: number; width: number; height: number }>,
): boolean {
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  const samples = Math.max(4, Math.ceil(distance / 12));
  for (let index = 1; index <= samples; index += 1) {
    const progress = index / samples;
    const candidate = {
      x: start.x + (end.x - start.x) * progress,
      y: start.y + (end.y - start.y) * progress,
      width: size,
      height: size,
    };
    if (!rectangleClear(candidate, obstacles)) return false;
  }
  return true;
}

function resolveFuraRoamStep(
  start: FuraPoint,
  requested: FuraPoint,
  viewport: FuraViewport,
  rightInset = 0,
  bottomInset?: number,
): FuraPoint {
  const size = furaCharacterSize(viewport);
  const obstacles = visibleFuraRoamObstacles();
  const requestedDelta = { x: requested.x - start.x, y: requested.y - start.y };
  const candidates = [
    requested,
    { x: start.x, y: requested.y },
    { x: requested.x, y: start.y },
    { x: start.x - requestedDelta.x, y: requested.y },
    { x: requested.x, y: start.y - requestedDelta.y },
  ].map((candidate) => clampFuraPosition(candidate, viewport, rightInset, bottomInset));

  return candidates.find((candidate) => (
    rectangleClear({ ...candidate, width: size, height: size }, obstacles)
    && furaPathClear(start, candidate, size, obstacles)
  )) ?? start;
}

function resolveFuraDrop(
  position: FuraPoint,
  viewport: FuraViewport,
  rightInset = 0,
  bottomInset?: number,
): FuraPoint {
  const size = furaCharacterSize(viewport);
  const obstacles = visibleAvoidanceRectangles();
  let resolved = clampFuraPosition(position, viewport, rightInset, bottomInset);
  const boxFor = (candidate: FuraPoint) => ({ ...candidate, width: size, height: size });

  for (let pass = 0; pass < obstacles.length + 1; pass += 1) {
    const collision = obstacles.find((rect) => rectanglesIntersect(boxFor(resolved), rect));
    if (!collision) return resolved;
    const candidates = [
      { x: collision.x - size - 8, y: resolved.y },
      { x: collision.x + collision.width + 8, y: resolved.y },
      { x: resolved.x, y: collision.y - size - 8 },
      { x: resolved.x, y: collision.y + collision.height + 8 },
    ].map((candidate) => clampFuraPosition(candidate, viewport, rightInset, bottomInset));
    const valid = candidates.filter((candidate) => (
      !obstacles.some((rect) => rectanglesIntersect(boxFor(candidate), rect))
    ));
    const pool = valid.length ? valid : candidates;
    resolved = pool.reduce((nearest, candidate) => {
      const nearestDistance = Math.hypot(nearest.x - position.x, nearest.y - position.y);
      const candidateDistance = Math.hypot(candidate.x - position.x, candidate.y - position.y);
      return candidateDistance < nearestDistance ? candidate : nearest;
    });
  }
  return resolved;
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ));

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return reduced;
}

function actionIsAllowed(message: FuraGuidanceMessage, action: FuraGuidanceAction): boolean {
  return message.actions.includes(action);
}

export function FuraCompanion({
  message,
  motionEnabled,
  notebookOpen = false,
  hidden = false,
  suspended = false,
  rightInset = 0,
  bottomInset,
  busy = false,
  labels: labelOverrides,
  spriteUrl = "/assets/fura/fura-motion-atlas.webp",
  className = "",
  onOpenNotebook,
  onInspectReason,
  onStartDiagnosis,
  onSnooze,
  onDismiss,
  onOpenSource,
  onAnswer,
}: FuraCompanionProps) {
  const labels = useMemo(() => ({ ...DEFAULT_LABELS, ...labelOverrides }), [labelOverrides]);
  const reducedMotion = useReducedMotion();
  const [pageVisible, setPageVisible] = useState(() => (
    typeof document === "undefined" || document.visibilityState === "visible"
  ));
  const [pose, setPose] = useState<FuraPose>("neutral");
  const [answer, setAnswer] = useState("");
  const [answering, setAnswering] = useState(false);
  const [guidanceExpanded, setGuidanceExpanded] = useState(() => currentViewport().width > 700);
  const [dragging, setDragging] = useState(false);
  const [pointerActive, setPointerActive] = useState(false);
  const [interactionPaused, setInteractionPaused] = useState(false);
  const [roamOffset, setRoamOffset] = useState<FuraPoint>({ x: 0, y: 0 });
  const [roamDuration, setRoamDuration] = useState(0);
  const [roaming, setRoaming] = useState(false);
  const [viewport, setViewport] = useState<FuraViewport>(currentViewport);
  const storedPositionRatio = useRef<FuraPoint | null>(readStoredFuraPosition());
  const [position, setPosition] = useState<FuraPoint>(() => (
    storedPositionRatio.current
      ? positionFromRatio(storedPositionRatio.current, currentViewport())
      : defaultFuraPosition(currentViewport(), bottomInset)
  ));
  const [guidanceSize, setGuidanceSize] = useState({ width: 312, height: 220 });
  const [avoidanceRects, setAvoidanceRects] = useState<ReturnType<typeof visibleAvoidanceRectangles>>([]);
  const motionSequenceIndex = useRef(0);
  const guidanceElement = useRef<HTMLElement | null>(null);
  const roamElement = useRef<HTMLDivElement | null>(null);
  const dragState = useRef<FuraDragState | null>(null);
  const suppressNotebookClick = useRef(false);
  const messageKey = message ? `${message.id}:${message.fingerprint}` : "";
  const hasMessage = messageKey !== "";

  useEffect(() => {
    const update = () => setPageVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    const update = () => {
      const nextViewport = currentViewport();
      setViewport(nextViewport);
      const preferred = storedPositionRatio.current
        ? positionFromRatio(storedPositionRatio.current, nextViewport)
        : defaultFuraPosition(nextViewport, bottomInset);
      window.requestAnimationFrame(() => {
        setPosition(resolveFuraDrop(preferred, nextViewport, rightInset, bottomInset));
      });
    };
    window.addEventListener("resize", update, { passive: true });
    return () => window.removeEventListener("resize", update);
  }, [bottomInset, rightInset]);

  useEffect(() => {
    if (hidden) return;
    const preferred = storedPositionRatio.current
      ? positionFromRatio(storedPositionRatio.current, viewport)
      : defaultFuraPosition(viewport, bottomInset);
    const frame = window.requestAnimationFrame(() => {
      setPosition(resolveFuraDrop(preferred, viewport, rightInset, bottomInset));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [bottomInset, hidden, rightInset, viewport]);

  useEffect(() => {
    const element = guidanceElement.current;
    if (!element || typeof ResizeObserver === "undefined") return () => undefined;
    const update = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) setGuidanceSize({ width: rect.width, height: rect.height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [hidden, messageKey]);

  useEffect(() => {
    if (hidden) return;
    const frame = window.requestAnimationFrame(() => setAvoidanceRects(visibleAvoidanceRectangles()));
    return () => window.cancelAnimationFrame(frame);
  }, [bottomInset, hidden, messageKey, rightInset, viewport.height, viewport.width]);

  useEffect(() => {
    setAnswer("");
    setAnswering(false);
    setGuidanceExpanded(viewport.width > 700);
  }, [message?.id, message?.fingerprint, viewport.width]);

  const characterSize = furaCharacterSize(viewport);
  const displayPosition = clampFuraPosition(position, viewport, rightInset, bottomInset);
  const actionBusy = busy || answering;
  const canAnimate = motionEnabled
    && !reducedMotion
    && pageVisible
    && !hidden
    && !suspended
    && !pointerActive
    && !interactionPaused
    && !actionBusy;

  useEffect(() => {
    let timer = 0;
    let cancelled = false;

    if (!canAnimate || notebookOpen || guidanceExpanded) {
      setPose(hasMessage || notebookOpen ? "notebook" : "neutral");
      setRoaming(false);
      setRoamDuration(0);
      setRoamOffset({ x: 0, y: 0 });
      return () => undefined;
    }

    const scheduleNext = (first = false) => {
      // Keep Fura visibly alive without a render loop. One CSS transition does
      // the continuous movement; React only advances each bounded waypoint.
      const delay = first
        ? 350
        : 1700 + Math.round(Math.random() * 1300);
      timer = window.setTimeout(() => {
        const sequence = MOTION_SEQUENCES[motionSequenceIndex.current % MOTION_SEQUENCES.length];
        motionSequenceIndex.current += 1;
        let index = 0;
        let previousOffset = { x: 0, y: 0 };
        const horizontalDirection = displayPosition.x + furaCharacterSize(viewport) / 2 > viewport.width / 2 ? -1 : 1;
        const playStep = () => {
          if (cancelled) return;
          const step = sequence[index];
          const requestedOffset = step.offset ?? { x: 0, y: 0 };
          const previousPosition = {
            x: displayPosition.x + previousOffset.x,
            y: displayPosition.y + previousOffset.y,
          };
          const requestedPosition = {
            x: displayPosition.x + requestedOffset.x * horizontalDirection,
            y: displayPosition.y + requestedOffset.y,
          };
          const resolvedPosition = resolveFuraRoamStep(
            previousPosition,
            requestedPosition,
            viewport,
            rightInset,
            bottomInset,
          );
          const nextOffset = {
            x: resolvedPosition.x - displayPosition.x,
            y: resolvedPosition.y - displayPosition.y,
          };
          const direction = nextOffset.x - previousOffset.x;
          const nextPose: FuraPose = step.pose === "walk-out"
            ? (direction < 0 ? "walk-left" : "walk-right")
            : step.pose === "walk-back"
              ? (direction < 0 ? "walk-left" : "walk-right")
              : step.pose;
          setRoaming(step.pose === "walk-out" || step.pose === "walk-back");
          setRoamDuration(step.duration);
          setRoamOffset(nextOffset);
          setPose(nextPose);
          previousOffset = nextOffset;
          timer = window.setTimeout(() => {
            index += 1;
            if (index < sequence.length) playStep();
            else {
              setRoaming(false);
              setRoamDuration(620);
              setRoamOffset({ x: 0, y: 0 });
              setPose("neutral");
              scheduleNext();
            }
          }, step.duration);
        };
        playStep();
      }, delay);
    };

    if (hasMessage) {
      setPose("notebook");
      timer = window.setTimeout(() => {
        setPose("neutral");
        scheduleNext(true);
      }, 1050);
    } else {
      setPose("neutral");
      scheduleNext(true);
    }
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [bottomInset, canAnimate, displayPosition.x, displayPosition.y, guidanceExpanded, hasMessage, messageKey, notebookOpen, rightInset, viewport]);

  const roamPosition = useMemo(() => clampFuraPosition({
    x: displayPosition.x + roamOffset.x,
    y: displayPosition.y + roamOffset.y,
  }, viewport, rightInset, bottomInset), [bottomInset, displayPosition.x, displayPosition.y, rightInset, roamOffset.x, roamOffset.y, viewport]);
  const bubblePlacement = useMemo(() => {
    const topInset = viewport.width <= 560 ? 136 : 76;
    const lowerInset = 70;
    const rightBoundary = Math.max(10, viewport.width - 10 - Math.max(0, rightInset));
    const compact = !guidanceExpanded;
    const preferredWidth = compact ? 44 : Math.max(280, guidanceSize.width);
    const preferredHeight = compact ? 44 : Math.max(150, guidanceSize.height);
    const width = Math.min(preferredWidth, Math.max(compact ? 44 : 220, rightBoundary - 10));
    const height = Math.min(preferredHeight, Math.max(compact ? 44 : 120, viewport.height - topInset - lowerInset));
    const maximumLeft = Math.max(10, rightBoundary - width);
    const maximumTop = Math.max(topInset, viewport.height - lowerInset - height);
    const roamClearance = 12;
    const clampCandidate = (side: string, x: number, y: number) => ({
      side,
      x: Math.min(maximumLeft, Math.max(10, x)),
      y: Math.min(maximumTop, Math.max(topInset, y)),
      width,
      height,
    });
    const centerX = displayPosition.x + characterSize / 2;
    const centerY = displayPosition.y + characterSize / 2;
    const candidates = {
      left: clampCandidate("left", compact ? displayPosition.x - width + 6 : displayPosition.x - width - 12, compact ? displayPosition.y + characterSize * 0.08 : centerY - height / 2),
      right: clampCandidate("right", compact ? displayPosition.x + characterSize - 6 : displayPosition.x + characterSize + 12, compact ? displayPosition.y + characterSize * 0.08 : centerY - height / 2),
      above: clampCandidate("above", centerX - width / 2, displayPosition.y - height - roamClearance),
      below: clampCandidate("below", centerX - width / 2, displayPosition.y + characterSize + roamClearance),
    };
    if (compact) {
      const compactPreference = centerX >= rightBoundary / 2
        ? ["left", "right", "above", "below"] as const
        : ["right", "left", "above", "below"] as const;
      const clear = compactPreference.map((side) => candidates[side]).find((candidate) => rectangleClear(candidate, avoidanceRects));
      return clear ?? candidates[compactPreference[0]];
    }
    const horizontalPreference = centerX >= rightBoundary / 2
      ? ["left", "above", "below", "right"] as const
      : ["right", "above", "below", "left"] as const;
    const verticalPreference = centerY >= viewport.height / 2
      ? ["above", "left", "right", "below"] as const
      : ["below", "right", "left", "above"] as const;
    const preference = viewport.width <= 700 ? verticalPreference : horizontalPreference;
    const characterRect = {
      x: displayPosition.x,
      y: displayPosition.y,
      width: characterSize,
      height: characterSize,
    };
    const obstacles = [...avoidanceRects, characterRect];
    const clear = preference.map((side) => candidates[side]).find((candidate) => rectangleClear(candidate, obstacles));
    if (clear) return clear;
    return preference.map((side) => candidates[side]).reduce((best, candidate) => {
      const score = obstacles.reduce((total, obstacle) => total + (rectanglesIntersect(candidate, obstacle) ? 1 : 0), 0);
      const bestScore = obstacles.reduce((total, obstacle) => total + (rectanglesIntersect(best, obstacle) ? 1 : 0), 0);
      return score < bestScore ? candidate : best;
    });
  }, [avoidanceRects, characterSize, displayPosition.x, displayPosition.y, guidanceExpanded, guidanceSize.height, guidanceSize.width, rightInset, viewport]);
  const bubbleTailPlacement = useMemo(() => {
    const size = 18;
    const targetX = displayPosition.x + characterSize / 2;
    const targetY = displayPosition.y + characterSize * (guidanceExpanded ? 0.5 : 0.34);
    const clampX = (value: number) => Math.min(bubblePlacement.x + bubblePlacement.width - size - 8, Math.max(bubblePlacement.x + 8, value));
    const clampY = (value: number) => Math.min(bubblePlacement.y + bubblePlacement.height - size - 8, Math.max(bubblePlacement.y + 8, value));
    if (bubblePlacement.side === "left") return { x: bubblePlacement.x + bubblePlacement.width - 1, y: clampY(targetY - size / 2) };
    if (bubblePlacement.side === "right") return { x: bubblePlacement.x - size + 1, y: clampY(targetY - size / 2) };
    if (bubblePlacement.side === "above") return { x: clampX(targetX - size / 2), y: bubblePlacement.y + bubblePlacement.height - 1 };
    return { x: clampX(targetX - size / 2), y: bubblePlacement.y - size + 1 };
  }, [bubblePlacement, characterSize, displayPosition.x, displayPosition.y, guidanceExpanded]);

  function persistFuraPosition(next: FuraPoint) {
    const ratio = {
      x: Math.min(1, Math.max(0, (next.x + characterSize / 2) / viewport.width)),
      y: Math.min(1, Math.max(0, (next.y + characterSize / 2) / viewport.height)),
    };
    storedPositionRatio.current = ratio;
    try {
      window.localStorage.setItem(FURA_POSITION_STORAGE_KEY, JSON.stringify(ratio));
    } catch {
      // Position persistence is optional; dragging must still work in-memory.
    }
  }

  function pauseFuraAtCurrentPosition() {
    const rect = roamElement.current?.getBoundingClientRect();
    if (rect) {
      setPosition(clampFuraPosition({ x: rect.x, y: rect.y }, viewport, rightInset, bottomInset));
    }
    setRoaming(false);
    setRoamDuration(0);
    setRoamOffset({ x: 0, y: 0 });
  }

  function beginFuraDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!event.isPrimary || event.button !== 0) return;
    const parkedPosition = displayPosition;
    const movingRect = roamElement.current?.getBoundingClientRect();
    const visualPosition = movingRect
      ? clampFuraPosition({ x: movingRect.x, y: movingRect.y }, viewport, rightInset, bottomInset)
      : roamPosition;
    setPointerActive(true);
    setRoaming(false);
    setRoamDuration(0);
    setRoamOffset({ x: 0, y: 0 });
    setPosition(visualPosition);
    dragState.current = {
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      parkedOrigin: parkedPosition,
      origin: visualPosition,
      latest: visualPosition,
      moved: false,
    };
    suppressNotebookClick.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveFura(event: ReactPointerEvent<HTMLButtonElement>) {
    const active = dragState.current;
    if (!event.isPrimary || !active || active.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - active.pointerX;
    const deltaY = event.clientY - active.pointerY;
    if (!active.moved && Math.hypot(deltaX, deltaY) < FURA_DRAG_THRESHOLD) return;
    active.moved = true;
    setDragging(true);
    event.preventDefault();
    const next = clampFuraPosition({
      x: active.origin.x + deltaX,
      y: active.origin.y + deltaY,
    }, viewport, rightInset, bottomInset);
    active.latest = next;
    setPosition(next);
  }

  function finishFuraDrag(event: ReactPointerEvent<HTMLButtonElement>, cancelled = false) {
    const active = dragState.current;
    if (!event.isPrimary || !active || active.pointerId !== event.pointerId) return;
    dragState.current = null;
    setDragging(false);
    setPointerActive(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (cancelled) {
      setPosition(active.parkedOrigin);
      return;
    }
    if (!active.moved) {
      setPosition(active.parkedOrigin);
      return;
    }
    const resolved = resolveFuraDrop(active.latest, viewport, rightInset, bottomInset);
    setPosition(resolved);
    persistFuraPosition(resolved);
    suppressNotebookClick.current = true;
  }

  function handleFuraClick(event: ReactMouseEvent<HTMLButtonElement>) {
    if (suppressNotebookClick.current) {
      suppressNotebookClick.current = false;
      event.preventDefault();
      return;
    }
    onOpenNotebook();
  }

  function moveFuraWithKeyboard(event: ReactKeyboardEvent<HTMLButtonElement>) {
    const step = event.shiftKey ? 32 : 16;
    const delta = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    }[event.key];
    if (!delta && event.key !== "Home") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Home") {
      storedPositionRatio.current = null;
      try {
        window.localStorage.removeItem(FURA_POSITION_STORAGE_KEY);
      } catch {
        // Reset remains functional for this session when storage is blocked.
      }
      setPosition(resolveFuraDrop(defaultFuraPosition(viewport, bottomInset), viewport, rightInset, bottomInset));
      return;
    }
    if (!delta) return;
    const resolved = resolveFuraDrop({
      x: displayPosition.x + delta.x,
      y: displayPosition.y + delta.y,
    }, viewport, rightInset, bottomInset);
    setPosition(resolved);
    persistFuraPosition(resolved);
  }

  if (hidden) return null;

  const frame = POSE_FRAME[pose];
  const frameX = frame.column === 0 ? "0%" : `${(frame.column / 3) * 100}%`;
  const frameY = frame.row === 0 ? "0%" : `${(frame.row / 3) * 100}%`;
  const canInspect = Boolean(onInspectReason) && message !== null && actionIsAllowed(message, "inspect");
  const canDiagnose = Boolean(onStartDiagnosis)
    && message?.requestable === true
    && actionIsAllowed(message, "diagnose");
  const canSnooze = Boolean(onSnooze) && message !== null && actionIsAllowed(message, "snooze");
  const canDismiss = Boolean(onDismiss) && message !== null && actionIsAllowed(message, "dismiss");
  const canOpenSource = Boolean(onOpenSource)
    && message?.target?.source_url?.startsWith("https://") === true
    && actionIsAllowed(message, "source");
  const canAnswer = Boolean(onAnswer)
    && message?.kind === "question"
    && actionIsAllowed(message, "answer");

  async function submitAnswer() {
    const value = answer.trim();
    if (!message || !onAnswer || value.length < 1 || actionBusy) return;
    setAnswering(true);
    try {
      await onAnswer(message, value);
    } finally {
      setAnswering(false);
    }
  }

  return (
    <aside
      className={`fura-companion ${className}`.trim()}
      data-pose={pose}
      data-has-message={message ? "true" : "false"}
      data-motion={canAnimate ? "active" : "paused"}
      data-dragging={dragging ? "true" : "false"}
      data-roaming={roaming ? "true" : "false"}
      data-bubble-placement={bubblePlacement.side}
      data-guidance-expanded={guidanceExpanded ? "true" : "false"}
      aria-label={labels.character}
      style={{
        left: displayPosition.x,
        top: displayPosition.y,
        "--fura-roam-x": `${roamPosition.x - displayPosition.x}px`,
        "--fura-roam-y": `${roamPosition.y - displayPosition.y}px`,
        "--fura-roam-ms": `${roamDuration}ms`,
      } as CSSProperties}
    >
      {message && (
        <section
          ref={guidanceElement}
          className="fura-guidance"
          aria-label={labels.guidance}
          aria-live="polite"
          aria-busy={actionBusy}
          onPointerEnter={(event) => {
            if (event.pointerType === "mouse") {
              pauseFuraAtCurrentPosition();
              setInteractionPaused(true);
            }
          }}
          onPointerLeave={(event) => {
            if (event.pointerType === "mouse") setInteractionPaused(false);
          }}
          onFocusCapture={() => {
            pauseFuraAtCurrentPosition();
            setInteractionPaused(true);
          }}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setInteractionPaused(false);
          }}
          style={{ left: bubblePlacement.x, top: bubblePlacement.y }}
        >
          <button
            type="button"
            className="fura-guidance-toggle"
            aria-expanded={guidanceExpanded}
            aria-label={guidanceExpanded ? labels.collapseGuidance : labels.expandGuidance}
            onClick={() => setGuidanceExpanded((value) => !value)}
          >
            {guidanceExpanded ? <>
              <span className="fura-guidance-name">{labels.name}</span>
              <strong>{message.title}</strong>
              <ChevronUp size={17} />
            </> : <span className="fura-guidance-ellipsis" aria-hidden="true">…</span>}
          </button>
          {guidanceExpanded && <p>{message.body}</p>}

          {guidanceExpanded && canAnswer && (
            <form
              className="fura-answer"
              onSubmit={(event) => {
                event.preventDefault();
                void submitAnswer();
              }}
            >
              <label htmlFor={`fura-answer-${message.id}`} className="fura-visually-hidden">
                {labels.answerLabel}: {message.title}
              </label>
              <textarea
                id={`fura-answer-${message.id}`}
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
                placeholder={labels.answerPlaceholder}
                rows={3}
                maxLength={1800}
                disabled={actionBusy}
              />
              <button type="submit" disabled={answer.trim().length < 1 || actionBusy}>
                {answering ? <LoaderCircle className="fura-spin" size={16} /> : <Send size={16} />}
                {answering ? labels.sendingAnswer : labels.sendAnswer}
              </button>
              <small className="fura-answer-boundary">{labels.answerBoundary}</small>
            </form>
          )}

          {guidanceExpanded && (canInspect || canDiagnose || canOpenSource || canSnooze || canDismiss) && (
            <div className="fura-guidance-actions">
              {canInspect && (
                <button type="button" onClick={() => onInspectReason?.(message)} disabled={actionBusy}>
                  <Search size={16} />{labels.inspect}
                </button>
              )}
              {canDiagnose && (
                <button className="is-primary" type="button" onClick={() => onStartDiagnosis?.(message)} disabled={actionBusy}>
                  <Stethoscope size={16} />{labels.diagnose}
                </button>
              )}
              {canOpenSource && (
                <button type="button" onClick={() => onOpenSource?.(message)} disabled={actionBusy}>
                  <ExternalLink size={16} />{labels.openSource}
                </button>
              )}
              {canSnooze && (
                <button type="button" onClick={() => void onSnooze?.(message)} disabled={actionBusy}>
                  <Clock3 size={16} />{labels.snooze}
                </button>
              )}
              {canDismiss && (
                <button type="button" onClick={() => void onDismiss?.(message)} disabled={actionBusy}>
                  <EyeOff size={16} />{labels.dismiss}
                </button>
              )}
            </div>
          )}
        </section>
      )}
      {message && (
        <span
          className="fura-guidance-tail"
          data-side={bubblePlacement.side}
          aria-hidden="true"
          style={{ left: bubbleTailPlacement.x, top: bubbleTailPlacement.y }}
        />
      )}

      <div
        ref={roamElement}
        className="fura-roam-layer"
        style={{
          "--fura-roam-x": `${roamPosition.x - displayPosition.x}px`,
          "--fura-roam-y": `${roamPosition.y - displayPosition.y}px`,
          "--fura-roam-ms": `${roamDuration}ms`,
        } as CSSProperties}
      >
        <button
          type="button"
          className="fura-character-button"
          aria-label={labels.openNotebook}
          aria-describedby="fura-drag-instruction"
          aria-expanded={notebookOpen}
          title={labels.dragHint}
          onPointerDown={beginFuraDrag}
          onPointerMove={moveFura}
          onPointerUp={(event) => finishFuraDrag(event)}
          onPointerCancel={(event) => finishFuraDrag(event, true)}
          onLostPointerCapture={(event) => finishFuraDrag(event, true)}
          onClick={handleFuraClick}
          onKeyDown={moveFuraWithKeyboard}
          onPointerEnter={(event) => {
            if (event.pointerType === "mouse") {
              pauseFuraAtCurrentPosition();
              setInteractionPaused(true);
            }
          }}
          onPointerLeave={(event) => {
            if (event.pointerType === "mouse") setInteractionPaused(false);
          }}
          onFocus={() => {
            pauseFuraAtCurrentPosition();
            setInteractionPaused(true);
          }}
          onBlur={() => setInteractionPaused(false)}
          onDragStart={(event) => event.preventDefault()}
        >
          <span
            className="fura-sprite"
            aria-hidden="true"
            style={{
              backgroundImage: `url(${spriteUrl})`,
              backgroundPosition: `${frameX} ${frameY}`,
            }}
          />
          <span className="fura-heartbeat" aria-hidden="true" />
          <span className="fura-notebook-label"><BookOpen size={15} />{labels.name}</span>
          <span id="fura-drag-instruction" className="fura-visually-hidden">{labels.dragHint}</span>
        </button>
      </div>
    </aside>
  );
}
