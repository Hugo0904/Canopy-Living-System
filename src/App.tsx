import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  BrainCircuit,
  CalendarDays,
  CircleHelp,
  ChevronRight,
  Database,
  Dna,
  FileCode2,
  FolderTree,
  GitBranch,
  Home,
  Maximize2,
  Minimize2,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Sprout,
  Stethoscope,
  TreePine,
  Users,
  Volume2,
  VolumeX,
  Waves,
  X,
} from "lucide-react";
import { fetchLifeEvents, fetchSnapshot, syncSnapshot } from "./api";
import { AmbientBgm, ambientTrackInfo, playUiClick, type AmbientTrackId } from "./audio/ambientBgm";
import { CanopyScene, type EffectDistance, type VisualEffects } from "./components/CanopyScene";
import { ActivityTimeline } from "./components/ActivityTimeline";
import { EvolutionLab } from "./components/EvolutionLab";
import { LifeStreamPanel } from "./components/LifeStreamPanel";
import { TreatmentComposer } from "./components/TreatmentComposer";
import {
  activityKind,
  activityStatus,
  cardDisplayName,
  localizedCategory,
  localizedDimension,
  localizedIssueTitle,
  localizedLifecycle,
  localizedSource,
  metricLabel,
  moduleName,
  moduleSummary,
  moduleZone,
  structureDisplayName,
  structureKind,
  t,
  type Locale,
} from "./i18n";
import type { ActivityEvent, ActivityProjection, CanopyConnection, CanopySnapshot, HealthStatus, LifeEventsResponse, ModuleHealth, SeedCard, StructureNode, TreatmentTarget } from "./types";

type BackgroundMode = "detailed" | "simple" | "none";
type ObservatoryView = "overview" | "seed" | "structure" | "timeline";
type SettingsTab = "general" | "effects";
type VisualEffectKey = Exclude<keyof VisualEffects, "master">;

interface StructureNavigationState {
  scope: "overview" | "inside";
  depth: number;
  selectedNode?: StructureNode;
  parentNode?: StructureNode;
  children: StructureNode[];
}

interface PendingTreatment {
  target: TreatmentTarget;
  intents: Array<"create" | "update" | "merge" | "archive" | "diagnose">;
  initialIntent?: "create" | "update" | "merge" | "archive" | "diagnose";
}

const MODULE_ICONS: Record<string, typeof BrainCircuit> = {
  "seed-memory": Sprout,
  "seed-core": Dna,
  brain: BrainCircuit,
  hooks: ShieldCheck,
  evolution: Sparkles,
  roles: Users,
  resources: Waves,
  receipts: Activity,
};

const LOCALES: Locale[] = ["zh-TW", "zh-CN", "en"];
const BACKGROUNDS: BackgroundMode[] = ["detailed", "simple", "none"];
const VISUAL_EFFECT_KEYS: VisualEffectKey[] = ["particles", "flow", "clouds", "glow", "motion"];
const MUSIC_TRACKS: AmbientTrackId[] = [
  "sacred-grove",
  "sakuya4",
  "shrine-ritual",
  "ancient-temple",
  "greenhouse",
  "meadow",
  "forest",
  "clear-sky",
  "sunlit-piano",
];

function deriveStructureNavigationState(
  nodes: StructureNode[],
  view: ObservatoryView,
  selectedStructureId: string,
  selectedModuleId: string,
): StructureNavigationState {
  const nodeIndex = new Map(nodes.map((node) => [node.id, node]));
  const scope = view === "structure" ? "inside" : "overview";
  const selectedNode = scope === "inside"
    ? nodeIndex.get(selectedStructureId)
    : nodeIndex.get(`module:${selectedModuleId}`);
  const children = selectedNode ? nodes.filter((node) => node.parent_id === selectedNode.id) : [];
  const parentNode = scope === "inside" && selectedNode?.parent_id
    ? nodeIndex.get(selectedNode.parent_id)
    : undefined;
  let depth = 0;
  let current = scope === "inside" ? selectedNode : undefined;
  const visited = new Set<string>();
  while (current?.parent_id && !visited.has(current.id)) {
    visited.add(current.id);
    const parent = nodeIndex.get(current.parent_id);
    if (!parent) break;
    depth += 1;
    current = parent;
  }
  return { scope, depth, selectedNode, parentNode, children };
}

function storedChoice<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const stored = window.localStorage.getItem(key) as T | null;
  return stored && allowed.includes(stored) ? stored : fallback;
}

function storedVolume(key: string, fallback: number): number {
  const raw = window.localStorage.getItem(key);
  if (raw === null) return fallback;
  const stored = Number(raw);
  return Number.isFinite(stored) && stored >= 0 && stored <= 1 ? stored : fallback;
}

function storedToggle(key: string, fallback: boolean): boolean {
  const raw = window.localStorage.getItem(key);
  if (raw === "on") return true;
  if (raw === "off") return false;
  return fallback;
}

function storedVisualEffects(): VisualEffects {
  return {
    // New browsers and development sessions start quiet. Individual choices
    // remain ready so enabling the master restores the full scene in one step.
    master: storedToggle("canopy.effects.master", false),
    particles: storedToggle("canopy.effects.particles", true),
    flow: storedToggle("canopy.effects.flow", true),
    clouds: storedToggle("canopy.effects.clouds", true),
    glow: storedToggle("canopy.effects.glow", true),
    motion: storedToggle("canopy.effects.motion", true),
  };
}

function MetricValue({ value, locale }: { value: unknown; locale: Locale }) {
  if (value === null || value === undefined || value === "") return <span>{t(locale, "common.unreported")}</span>;
  if (typeof value === "number") return <span>{value.toLocaleString(locale)}</span>;
  return <span>{String(value)}</span>;
}

function StatusPill({ status, locale }: { status: HealthStatus; locale: Locale }) {
  return (
    <span className="status-pill" data-status={status}>
      <span className="status-dot" data-status={status} />
      {t(locale, `status.${status}`)}
    </span>
  );
}

function LoadingScreen({ locale }: { locale: Locale }) {
  return (
    <main className="loading-screen">
      <div className="loading-mark"><TreePine size={28} /><span>CANOPY</span></div>
      <div className="loading-copy"><span>{t(locale, "loading.signals")}</span><div className="loading-line" /></div>
    </main>
  );
}

function ArchitectureFlows({
  module,
  connections,
  locale,
  onSelectModule,
}: {
  module: ModuleHealth;
  connections: CanopyConnection[];
  locale: Locale;
  onSelectModule: (moduleId: string) => void;
}) {
  const relevant = connections.filter((connection) => connection.source === module.id || connection.target === module.id);
  if (!relevant.length) return null;
  return (
    <section className="architecture-flows" aria-label={t(locale, "flow.section")} data-testid="architecture-flows">
      <h3>{t(locale, "flow.section")}</h3>
      <div className="flow-list">
        {relevant.map((connection) => {
          const outgoing = connection.source === module.id;
          const peerId = outgoing ? connection.target : connection.source;
          return (
            <button key={connection.id} onClick={() => onSelectModule(peerId)}>
              <span className="flow-route">
                <em>{t(locale, outgoing ? "flow.outgoing" : "flow.incoming")}</em>
                <span>{moduleName(locale, connection.source)}</span>
                <ArrowRight size={13} />
                <span>{moduleName(locale, connection.target)}</span>
              </span>
              <strong>{t(locale, connection.label_key)}</strong>
              <small>{t(locale, `phase.${connection.phase}`)} · {t(locale, connection.description_key)}</small>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function derivePublicSourcePaths(nodes: StructureNode[], rootId: string): string[] {
  const children = new Map<string, StructureNode[]>();
  nodes.forEach((node) => {
    if (!node.parent_id) return;
    const siblings = children.get(node.parent_id) ?? [];
    siblings.push(node);
    children.set(node.parent_id, siblings);
  });
  const root = nodes.find((node) => node.id === rootId);
  if (!root) return [];
  const pending = [root];
  const visited = new Set<string>();
  const paths = new Set<string>();
  while (pending.length) {
    const current = pending.shift();
    if (!current || visited.has(current.id)) continue;
    visited.add(current.id);
    if (current.path) paths.add(current.path);
    (children.get(current.id) ?? []).forEach((child) => pending.push(child));
  }
  return [...paths];
}

function ProjectionNotice({ locale }: { locale: Locale }) {
  return (
    <p className="topology-projection-notice">
      <GitBranch size={14} />
      <span><strong>{t(locale, "topology.projection_title")}</strong>{t(locale, "topology.projection_note")}</span>
    </p>
  );
}

function PublicSourcePaths({ paths, locale }: { paths: string[]; locale: Locale }) {
  const visible = paths.slice(0, 8);
  return (
    <section className="public-source-paths" aria-label={t(locale, "topology.public_sources")}>
      <h3>{t(locale, "topology.public_sources")}</h3>
      {visible.length ? (
        <>
          <ul>{visible.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
          {paths.length > visible.length && <small>{t(locale, "topology.more_sources", { count: paths.length - visible.length })}</small>}
        </>
      ) : <p>{t(locale, "topology.no_public_source")}</p>}
    </section>
  );
}

function DetailPanel({
  module,
  card,
  structureNode,
  structureNodes,
  structureNavigation,
  connections,
  activity,
  locale,
  onEnterSeed,
  onEnterStructure,
  onTreatCard,
  onTreatModule,
  onSelectModule,
  onSelectStructure,
  onLeaveStructure,
  onClose,
}: {
  module?: ModuleHealth;
  card?: SeedCard;
  structureNode?: StructureNode;
  structureNodes: StructureNode[];
  structureNavigation: StructureNavigationState;
  connections: CanopyConnection[];
  activity?: ActivityProjection;
  locale: Locale;
  onEnterSeed: () => void;
  onEnterStructure: (nodeId: string) => void;
  onTreatCard: (card: SeedCard) => void;
  onTreatModule: (module: ModuleHealth) => void;
  onSelectModule: (moduleId: string) => void;
  onSelectStructure: (nodeId: string) => void;
  onLeaveStructure: () => void;
  onClose: () => void;
}) {
  if (card) {
    return (
      <aside className="detail-panel" aria-label={t(locale, "aria.card_details")}>
        <div className="detail-heading">
          <div>
            <span className="eyebrow">SEED MEMORY</span>
            <h2>{cardDisplayName(locale, card)}</h2>
            <code className="original-card-id">{card.id}</code>
          </div>
          <div className="detail-actions"><StatusPill status={card.health.status} locale={locale} /><button className="icon-button" onClick={onClose} aria-label={t(locale, "common.close")}><X size={16} /></button></div>
        </div>
        <p className="detail-summary">{card.summary || t(locale, "common.no_summary")}</p>
        <dl className="detail-facts">
          <div><dt>{t(locale, "card.source")}</dt><dd>{localizedSource(locale, card.source_type)}</dd></div>
          <div><dt>{t(locale, "card.scope")}</dt><dd>{card.scope || t(locale, "common.unspecified")}</dd></div>
          <div><dt>{t(locale, "card.lifecycle")}</dt><dd>{localizedLifecycle(locale, card.lifecycle)}</dd></div>
          <div><dt>{t(locale, "card.review")}</dt><dd>{card.review_after || t(locale, "common.unscheduled")}</dd></div>
        </dl>
        {card.encouragement && <div className="guidance-block"><Sprout size={18} /><p>{card.encouragement}</p></div>}
        {card.reflection_question && <div className="reflection-block"><CircleHelp size={18} /><p>{card.reflection_question}</p></div>}
        <div className="trigger-list" aria-label="Triggers">
          {card.triggers.slice(0, 8).map((trigger) => <span key={trigger}>{trigger}</span>)}
        </div>
        <button className="primary-command" onClick={() => onTreatCard(card)}><Stethoscope size={18} />{t(locale, "card.propose_change")}</button>
      </aside>
    );
  }
  if (structureNode) {
    const children = structureNavigation.children;
    const dependencies = structureNode.dependencies
      .map((nodeId) => structureNodes.find((node) => node.id === nodeId))
      .filter((node): node is StructureNode => Boolean(node));
    const StructureIcon = structureNode.kind === "component" ? FileCode2 : structureNode.kind === "tissue" ? FolderTree : GitBranch;
    const publicSourcePaths = derivePublicSourcePaths(structureNodes, structureNode.id);
    return (
      <aside
        className="detail-panel"
        aria-label={t(locale, "aria.structure_details")}
        data-navigation-depth={structureNavigation.depth}
        data-navigation-scope={structureNavigation.scope}
      >
        <div className="detail-heading">
          <div className="module-title">
            <StructureIcon size={20} />
            <div><span className="eyebrow">{structureKind(locale, structureNode)}</span><h2>{structureDisplayName(locale, structureNode)}</h2></div>
          </div>
          <button className="icon-button" onClick={onClose} aria-label={t(locale, "common.close")}><X size={16} /></button>
        </div>
        <ProjectionNotice locale={locale} />
        <p className="detail-summary">{structureNode.summary || t(locale, "common.no_summary")}</p>
        <dl className="detail-facts">
          {structureNode.path && <div><dt>{t(locale, "structure.path")}</dt><dd><code className="structure-path">{structureNode.path}</code></dd></div>}
          <div><dt>{t(locale, "structure.children")}</dt><dd>{t(locale, "structure.child_count", { count: structureNode.child_count })}</dd></div>
          {structureNode.size_bytes > 0 && <div><dt>{t(locale, "structure.size")}</dt><dd>{structureNode.size_bytes.toLocaleString(locale)} B</dd></div>}
        </dl>
        <PublicSourcePaths paths={publicSourcePaths} locale={locale} />
        {structureNode.module_id === "evolution" && <EvolutionLab locale={locale} />}
        {children.length > 0 && (
          <section className="structure-relations">
            <h3>{t(locale, "structure.children")}</h3>
            {children.map((child) => (
              <button key={child.id} onClick={() => onSelectStructure(child.id)}>
                <span><strong>{structureDisplayName(locale, child)}</strong><small>{structureKind(locale, child)}</small></span><ChevronRight size={15} />
              </button>
            ))}
          </section>
        )}
        {dependencies.length > 0 && (
          <section className="structure-relations">
            <h3>{t(locale, "structure.dependencies")}</h3>
            {dependencies.slice(0, 8).map((dependency) => (
              <button key={dependency.id} onClick={() => onSelectStructure(dependency.id)}>
                <span><strong>{structureDisplayName(locale, dependency)}</strong><small>{dependency.path}</small></span><GitBranch size={14} />
              </button>
            ))}
          </section>
        )}
        {children.length === 0 && <p className="structure-empty">{t(locale, "structure.none")}</p>}
        <button className="secondary-command" onClick={onLeaveStructure}>
          <ArrowLeft size={18} />
          {structureNavigation.parentNode ? t(locale, "structure.back") : t(locale, "structure.back_to_overview")}
        </button>
      </aside>
    );
  }
  if (!module) return null;
  const Icon = MODULE_ICONS[module.id] ?? Activity;
  const activityIds = new Set(activity?.modules[module.id]?.event_ids ?? []);
  const recentActivity = activity?.events.filter((event) => activityIds.has(event.id)).slice(0, 5) ?? [];
  const publicSourcePaths = derivePublicSourcePaths(structureNodes, `module:${module.id}`);
  return (
    <aside className="detail-panel" aria-label={t(locale, "aria.module_details")}>
      <div className="detail-heading">
        <div className="module-title">
          <Icon size={20} />
          <div><span className="eyebrow">{moduleZone(locale, module.id, module.zone)}</span><h2>{moduleName(locale, module.id, module.name)}</h2></div>
        </div>
        <div className="detail-actions"><StatusPill status={module.health.status} locale={locale} /><button className="icon-button" onClick={onClose} aria-label={t(locale, "common.close")}><X size={16} /></button></div>
      </div>
      <ProjectionNotice locale={locale} />
      <p className="detail-summary">{moduleSummary(locale, module)}</p>
      <div className="vital-grid">
        <div><span>{t(locale, "metric.health")}</span><strong>{t(locale, `status.${module.health.status}`)}</strong></div>
        <div><span>{t(locale, "metric.activity")}</span><strong>{localizedDimension(locale, module.activity.label, "activity")}</strong></div>
        <div><span>{t(locale, "metric.impact")}</span><strong>{localizedDimension(locale, module.impact.label, "impact")}</strong></div>
        <div><span>{t(locale, "metric.evidence")}</span><strong>{localizedDimension(locale, module.confidence.level, "confidence")}</strong></div>
      </div>
      <dl className="metric-list">
        {Object.entries(module.metrics).slice(0, 7).map(([key, value]) => (
          <div key={key}><dt>{metricLabel(locale, key)}</dt><dd><MetricValue value={value} locale={locale} /></dd></div>
        ))}
      </dl>
      <PublicSourcePaths paths={publicSourcePaths} locale={locale} />
      {module.id === "evolution" && <EvolutionLab locale={locale} />}
      <section className="recent-activity">
        <h3>{t(locale, "activity.recent")}</h3>
        {recentActivity.length ? recentActivity.map((event) => (
          <div key={event.id}>
            <time>{new Date(event.occurred_at).toLocaleDateString(locale, { month: "numeric", day: "numeric" })}</time>
            <span><strong>{activityKind(locale, event.kind)}</strong><small>{event.summary}</small></span>
            <em>{activityStatus(locale, event.status)}</em>
          </div>
        )) : <p>{t(locale, "activity.no_recent")}</p>}
      </section>
      <ArchitectureFlows module={module} connections={connections} locale={locale} onSelectModule={onSelectModule} />
      {module.id === "seed-memory" && (
        <button className="primary-command" onClick={onEnterSeed}><Database size={18} />{t(locale, "card.enter_roots")}</button>
      )}
      {structureNavigation.scope === "overview" && structureNavigation.selectedNode && structureNavigation.children.length > 0 && (
        <button className="secondary-command" onClick={() => onEnterStructure(structureNavigation.selectedNode!.id)}><FolderTree size={18} />{t(locale, "structure.enter")}</button>
      )}
      <button className="secondary-command" onClick={() => onTreatModule(module)}><Stethoscope size={18} />{t(locale, "module.propose_change")}</button>
    </aside>
  );
}

function SeedNavigator({
  cards,
  selectedId,
  locale,
  onSelect,
  onCreate,
}: {
  cards: SeedCard[];
  selectedId: string;
  locale: Locale;
  onSelect: (id: string) => void;
  onCreate: () => void;
}) {
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return cards
      .filter((card) => card.lifecycle === "active")
      .filter((card) => !term || `${cardDisplayName(locale, card)} ${card.id} ${card.summary} ${card.triggers.join(" ")}`.toLowerCase().includes(term));
  }, [cards, locale, search]);
  return (
    <section className="seed-navigator" aria-label={t(locale, "aria.seed_cards")}>
      <div className="seed-toolbar">
        <div className="seed-search">
          <Search size={17} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t(locale, "card.search")} />
        </div>
        <button className="seed-create" onClick={onCreate} aria-label={t(locale, "card.create")} title={t(locale, "card.create")}><Plus size={17} /></button>
      </div>
      <div className="seed-list">
        {filtered.map((card) => (
          <button key={card.id} className={selectedId === card.id ? "is-active" : ""} onClick={() => onSelect(card.id)}>
            <span className="status-dot" data-status={card.health.status} />
            <span>
              <strong>{cardDisplayName(locale, card)}</strong>
              <code>{card.id}</code>
              <small>{localizedCategory(locale, card.category)} · {localizedSource(locale, card.source_type)}</small>
            </span>
          </button>
        ))}
      </div>
      <div className="seed-count">{t(locale, "card.active_count", { count: filtered.length })}</div>
    </section>
  );
}

function StructureBreadcrumb({
  nodes,
  selectedId,
  locale,
  onSelect,
}: {
  nodes: StructureNode[];
  selectedId: string;
  locale: Locale;
  onSelect: (id: string) => void;
}) {
  const nodeIndex = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const trail = useMemo(() => {
    const result: StructureNode[] = [];
    const visited = new Set<string>();
    let current = nodeIndex.get(selectedId);
    while (current && !visited.has(current.id)) {
      result.unshift(current);
      visited.add(current.id);
      current = current.parent_id ? nodeIndex.get(current.parent_id) : undefined;
    }
    return result;
  }, [nodeIndex, selectedId]);
  return (
    <nav className="structure-breadcrumb" aria-label={t(locale, "aria.structure_navigation")}>
      {trail.map((node, index) => (
        <span key={node.id}>
          {index > 0 && <ChevronRight size={13} />}
          <button className={index === trail.length - 1 ? "is-current" : ""} onClick={() => onSelect(node.id)}>{structureDisplayName(locale, node)}</button>
        </span>
      ))}
    </nav>
  );
}

function SettingsPanel({
  locale,
  backgroundMode,
  musicTrack,
  musicVolume,
  soundEffects,
  soundEffectVolume,
  visualEffects,
  effectDistance,
  onLocale,
  onBackground,
  onMusic,
  onMusicVolume,
  onSoundEffects,
  onSoundEffectVolume,
  onVisualEffects,
  onClose,
}: {
  locale: Locale;
  backgroundMode: BackgroundMode;
  musicTrack: AmbientTrackId;
  musicVolume: number;
  soundEffects: boolean;
  soundEffectVolume: number;
  visualEffects: VisualEffects;
  effectDistance: EffectDistance;
  onLocale: (value: Locale) => void;
  onBackground: (value: BackgroundMode) => void;
  onMusic: (value: AmbientTrackId) => void;
  onMusicVolume: (value: number) => void;
  onSoundEffects: (value: boolean) => void;
  onSoundEffectVolume: (value: number) => void;
  onVisualEffects: (value: VisualEffects) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<SettingsTab>("general");
  const trackInfo = ambientTrackInfo(musicTrack);
  const masterEnabled = visualEffects.master;
  function toggleVisualEffect(key: VisualEffectKey) {
    if (!masterEnabled) {
      const isolated: VisualEffects = {
        master: true,
        particles: false,
        flow: false,
        clouds: false,
        glow: false,
        motion: false,
      };
      isolated[key] = true;
      onVisualEffects(isolated);
      return;
    }
    onVisualEffects({ ...visualEffects, [key]: !visualEffects[key] });
  }
  return (
    <section className="settings-panel" aria-label={t(locale, "settings.title")}>
      <header>
        <div><Settings2 size={17} /><strong>{t(locale, "settings.title")}</strong></div>
        <button className="icon-button" onClick={onClose} aria-label={t(locale, "settings.close")}><X size={17} /></button>
      </header>
      <div className="settings-tabs" role="tablist" aria-label={t(locale, "settings.sections")}>
        <button role="tab" aria-selected={tab === "general"} className={tab === "general" ? "is-active" : ""} onClick={() => setTab("general")}>
          <Settings2 size={15} />{t(locale, "settings.tab_general")}
        </button>
        <button role="tab" aria-selected={tab === "effects"} className={tab === "effects" ? "is-active" : ""} onClick={() => setTab("effects")}>
          <Sparkles size={15} />{t(locale, "settings.tab_effects")}
        </button>
      </div>
      {tab === "general" ? <>
        <div className="settings-group">
        <span>{t(locale, "settings.language")}</span>
        <div className="settings-segments" data-testid="language-settings">
          {LOCALES.map((value) => (
            <button key={value} className={locale === value ? "is-active" : ""} aria-pressed={locale === value} onClick={() => onLocale(value)}>
              {value === "zh-TW" ? "繁體" : value === "zh-CN" ? "简体" : "EN"}
            </button>
          ))}
        </div>
        </div>
        <div className="settings-group">
        <span>{t(locale, "settings.background")}</span>
        <div className="settings-segments" data-testid="background-settings">
          {BACKGROUNDS.map((value) => (
            <button key={value} className={backgroundMode === value ? "is-active" : ""} aria-pressed={backgroundMode === value} onClick={() => onBackground(value)}>
              {t(locale, `settings.background_${value}`)}
            </button>
          ))}
        </div>
        </div>
        <div className="settings-group">
        <span>{t(locale, "settings.music")}</span>
        <div className="settings-segments music-options" data-testid="music-settings">
          {MUSIC_TRACKS.map((value) => (
            <button key={value} className={musicTrack === value ? "is-active" : ""} aria-pressed={musicTrack === value} onClick={() => onMusic(value)}>
              {t(locale, `music.${value}`)}
            </button>
          ))}
        </div>
        <label className="volume-control">
          <span>{t(locale, "settings.music_volume")}</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={musicVolume}
            aria-label={t(locale, "settings.music_volume")}
            onChange={(event) => onMusicVolume(Number(event.currentTarget.value))}
          />
          <output>{Math.round(musicVolume * 100)}%</output>
        </label>
        <p className="music-credit">
          <span>{t(locale, "settings.music_credit")}</span>
          <a href={trackInfo.sourceUrl} target="_blank" rel="noreferrer">{trackInfo.title} · {trackInfo.artist}</a>
          <a href={trackInfo.licenseUrl} target="_blank" rel="noreferrer">{trackInfo.license}</a>
        </p>
        </div>
        <div className="settings-group">
        <span>{t(locale, "settings.sound_effects")}</span>
        <div className="settings-segments two-options">
          {[true, false].map((value) => (
            <button key={String(value)} className={soundEffects === value ? "is-active" : ""} aria-pressed={soundEffects === value} onClick={() => onSoundEffects(value)}>
              {t(locale, value ? "settings.sound_effects_on" : "settings.sound_effects_off")}
            </button>
          ))}
        </div>
        <label className="volume-control">
          <span>{t(locale, "settings.sound_effects_volume")}</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={soundEffectVolume}
            aria-label={t(locale, "settings.sound_effects_volume")}
            onChange={(event) => onSoundEffectVolume(Number(event.currentTarget.value))}
          />
          <output>{Math.round(soundEffectVolume * 100)}%</output>
        </label>
        </div>
      </> : (
        <div className="effects-settings" data-testid="effects-settings">
          <div className="effect-master-row" data-enabled={masterEnabled ? "true" : "false"}>
            <div>
              <strong>{t(locale, "settings.effects_master")}</strong>
              <small>{t(locale, "settings.effects_master_detail")}</small>
            </div>
            <button
              className="settings-switch"
              role="switch"
              aria-label={t(locale, "settings.effects_master")}
              aria-checked={masterEnabled}
              data-enabled={masterEnabled ? "true" : "false"}
              onClick={() => onVisualEffects({ ...visualEffects, master: !masterEnabled })}
            >
              {t(locale, masterEnabled ? "settings.effects_on" : "settings.effects_off")}
            </button>
          </div>
          <p className="effects-performance-note" data-enabled={masterEnabled ? "true" : "false"}>
            {t(locale, masterEnabled ? "settings.effects_active_note" : "settings.effects_paused_note")}
            {masterEnabled && <span>{t(locale, `settings.effects_distance_${effectDistance}`)}</span>}
          </p>
          <div className="effect-list">
            {VISUAL_EFFECT_KEYS.map((key) => {
              const enabled = masterEnabled && visualEffects[key];
              return (
                <div className="effect-row" key={key} data-enabled={enabled ? "true" : "false"}>
                  <div>
                    <strong>{t(locale, `settings.effect_${key}`)}</strong>
                    <small>{t(locale, `settings.effect_${key}_detail`)}</small>
                  </div>
                  <button
                    className="settings-switch"
                    role="switch"
                    aria-label={t(locale, `settings.effect_${key}`)}
                    aria-checked={enabled}
                    data-enabled={enabled ? "true" : "false"}
                    onClick={() => toggleVisualEffect(key)}
                  >
                    {t(locale, enabled ? "settings.effects_on" : "settings.effects_off")}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

export default function App() {
  const [locale, setLocale] = useState<Locale>(() => storedChoice("canopy.locale", LOCALES, "zh-TW"));
  const [backgroundMode, setBackgroundMode] = useState<BackgroundMode>(() => storedChoice("canopy.background", BACKGROUNDS, "detailed"));
  const [musicTrack, setMusicTrack] = useState<AmbientTrackId>(() => {
    const storedTrack = window.localStorage.getItem("canopy.music");
    if (
      storedTrack === "resonant-chimes"
      || storedTrack === "finding-movement"
      || storedTrack === "kagura-awakening"
    ) return "sakuya4";
    return storedChoice("canopy.music", MUSIC_TRACKS, "meadow");
  });
  const [musicVolume, setMusicVolume] = useState(() => storedVolume("canopy.music.volume", 0.88));
  const [soundEffects, setSoundEffects] = useState(() => window.localStorage.getItem("canopy.sfx") !== "off");
  const [soundEffectVolume, setSoundEffectVolume] = useState(() => storedVolume("canopy.sfx.volume", 0.72));
  const [visualEffects, setVisualEffects] = useState<VisualEffects>(storedVisualEffects);
  const [effectDistance, setEffectDistance] = useState<EffectDistance>("far");
  const [bgmEnabled, setBgmEnabled] = useState(() => window.localStorage.getItem("canopy.bgm") !== "off");
  const [bgmActive, setBgmActive] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [audioError, setAudioError] = useState("");
  const [snapshot, setSnapshot] = useState<CanopySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [syncNotice, setSyncNotice] = useState("");
  const [view, setView] = useState<ObservatoryView>("overview");
  const [selectedModuleId, setSelectedModuleId] = useState("");
  const [selectedCardId, setSelectedCardId] = useState("");
  const [selectedStructureId, setSelectedStructureId] = useState("canopy-shell");
  const [focusRevision, setFocusRevision] = useState(0);
  const [detailOpen, setDetailOpen] = useState(false);
  const [compactHud, setCompactHud] = useState({ left: false, bottom: false });
  const [treatment, setTreatment] = useState<PendingTreatment | null>(null);
  const [selectedActivityDate, setSelectedActivityDate] = useState("");
  const [activityPlaying, setActivityPlaying] = useState(false);
  const [lifeStreamOpen, setLifeStreamOpen] = useState(
    () => window.localStorage.getItem("canopy.life-stream") !== "closed",
  );
  const [lifeEvents, setLifeEvents] = useState<ActivityEvent[]>([]);
  const [lifeStats, setLifeStats] = useState<LifeEventsResponse["stats"]>({ total: 0, oldest: "", newest: "" });
  const [lifeRetentionDays, setLifeRetentionDays] = useState(60);
  const [lifeSync, setLifeSync] = useState<LifeEventsResponse["sync"]>({
    status: "starting",
    last_synced_at: "",
    last_error: "",
    accepted: 0,
    persisted: 0,
  });
  const bgm = useRef<AmbientBgm | null>(null);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = t(locale, "brand.page_title");
    window.localStorage.setItem("canopy.locale", locale);
  }, [locale]);

  useEffect(() => {
    window.localStorage.setItem("canopy.background", backgroundMode);
  }, [backgroundMode]);

  useEffect(() => {
    window.localStorage.setItem("canopy.effects.master", visualEffects.master ? "on" : "off");
    VISUAL_EFFECT_KEYS.forEach((key) => {
      window.localStorage.setItem(`canopy.effects.${key}`, visualEffects[key] ? "on" : "off");
    });
  }, [visualEffects]);

  useEffect(() => {
    window.localStorage.setItem("canopy.life-stream", lifeStreamOpen ? "open" : "closed");
  }, [lifeStreamOpen]);

  useEffect(() => {
    if (!syncNotice) return;
    const timer = window.setTimeout(() => setSyncNotice(""), 4800);
    return () => window.clearTimeout(timer);
  }, [syncNotice]);

  useEffect(() => {
    if (detailOpen && lifeStreamOpen) setLifeStreamOpen(false);
  }, [detailOpen, lifeStreamOpen]);

  useEffect(() => {
    window.localStorage.setItem("canopy.music", musicTrack);
  }, [musicTrack]);

  useEffect(() => {
    window.localStorage.setItem("canopy.music.volume", String(musicVolume));
    bgm.current?.setVolume(musicVolume);
  }, [musicVolume]);

  useEffect(() => {
    window.localStorage.setItem("canopy.bgm", bgmEnabled ? "on" : "off");
    if (!bgmEnabled) {
      void bgm.current?.stop();
      setBgmActive(false);
      return;
    }

    let cancelled = false;
    let starting = false;
    const removeActivationListeners = () => {
      document.removeEventListener("click", activateOnGesture, true);
      window.removeEventListener("keydown", activateOnGesture);
    };
    const activate = async () => {
      if (starting || cancelled) return;
      starting = true;
      setAudioError("");
      try {
        bgm.current ??= new AmbientBgm();
        bgm.current.setVolume(musicVolume);
        const playing = await bgm.current.start(musicTrack);
        if (!cancelled) {
          setBgmActive(playing);
          if (playing) removeActivationListeners();
        }
      } catch {
        if (!cancelled) {
          setAudioError(t(locale, "audio.error"));
          setBgmActive(false);
        }
      } finally {
        starting = false;
      }
    };
    function activateOnGesture() { void activate(); }

    document.addEventListener("click", activateOnGesture, true);
    window.addEventListener("keydown", activateOnGesture);
    void activate();
    return () => {
      cancelled = true;
      removeActivationListeners();
    };
  }, [bgmEnabled, musicTrack]);

  useEffect(() => {
    window.localStorage.setItem("canopy.sfx", soundEffects ? "on" : "off");
    window.localStorage.setItem("canopy.sfx.volume", String(soundEffectVolume));
    if (!soundEffects) return;
    const click = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest("button:not(:disabled)") : null;
      if (target) playUiClick(soundEffectVolume);
    };
    document.addEventListener("click", click, true);
    return () => document.removeEventListener("click", click, true);
  }, [soundEffects, soundEffectVolume]);

  useEffect(() => () => { void bgm.current?.stop(true); }, []);

  useEffect(() => {
    let cancelled = false;
    async function syncLifeEvents(refresh = false) {
      try {
        const payload = await fetchLifeEvents(refresh);
        if (cancelled) return;
        setLifeEvents(payload.events);
        setLifeStats(payload.stats);
        setLifeRetentionDays(payload.retention_days);
        setLifeSync(payload.sync);
      } catch (reason) {
        if (cancelled) return;
        setLifeSync((current) => ({
          ...current,
          status: "degraded",
          last_error: reason instanceof Error ? reason.message : "Life event sync unavailable",
        }));
      }
    }
    // The backend owns automatic ingestion. Read its persisted projection on
    // mount so one page does not launch a second full Core scan at startup.
    void syncLifeEvents(false);
    const timer = window.setInterval(() => {
      if (!document.hidden) void syncLifeEvents(false);
    }, 3500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  async function load(refresh = false) {
    refresh ? setRefreshing(true) : setLoading(true);
    setError("");
    try {
      const next = await fetchSnapshot(refresh);
      setSnapshot(next);
      setLifeEvents((current) => current.length ? current : next.activity?.events ?? []);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t(locale, "fatal.title"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    if (!snapshot) return;
    const latestActivityDate = snapshot.activity?.daily[snapshot.activity.daily.length - 1]?.date ?? "";
    setSelectedActivityDate((current) => snapshot.activity?.daily.some((day) => day.date === current) ? current : latestActivityDate);
    setSelectedModuleId((current) => current && !snapshot.modules.some((module) => module.id === current)
      ? snapshot.modules[0]?.id ?? ""
      : current);
    setSelectedStructureId((current) => snapshot.structure && !snapshot.structure.nodes.some((node) => node.id === current)
      ? snapshot.structure.root_id
      : current);
  }, [snapshot]);

  useEffect(() => {
    let cancelled = false;
    const readPersistedProjection = async () => {
      if (document.hidden) return;
      try {
        const next = await fetchSnapshot(false);
        if (cancelled) return;
        setSnapshot((current) => current?.generated_at === next.generated_at ? current : next);
      } catch {
        // The visible last-known-good projection remains usable while the
        // backend retries. Manual sync surfaces a concrete error when needed.
      }
    };
    const timer = window.setInterval(() => { void readPersistedProjection(); }, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  async function synchronizeLivingSystem() {
    setRefreshing(true);
    setError("");
    setSyncNotice("");
    try {
      const result = await syncSnapshot();
      setSnapshot(result.snapshot);
      setLifeEvents((current) => current.length ? current : result.snapshot.activity?.events ?? []);
      setSyncNotice(t(locale, "sync.completed", {
        modules: result.sync.topology.module_count,
        connections: result.sync.topology.connection_count,
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t(locale, "fatal.title"));
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    if (!activityPlaying || !snapshot?.activity?.daily.length) return;
    const timer = window.setInterval(() => {
      setSelectedActivityDate((current) => {
        const days = snapshot.activity?.daily ?? [];
        const index = days.findIndex((day) => day.date === current);
        if (index < 0) return days[0]?.date ?? "";
        if (index >= days.length - 1) {
          setActivityPlaying(false);
          return current;
        }
        return days[index + 1].date;
      });
    }, 1150);
    return () => window.clearInterval(timer);
  }, [activityPlaying, snapshot?.activity]);

  const connections = snapshot?.connections ?? [];
  const structureNodes = snapshot?.structure?.nodes ?? [];
  const selectedModule = snapshot?.modules.find((module) => module.id === selectedModuleId);
  const selectedCard = snapshot?.seed_memory.cards.find((card) => card.id === selectedCardId);
  const selectedStructureNode = structureNodes.find((node) => node.id === selectedStructureId);
  const structureNavigation = useMemo(
    () => deriveStructureNavigationState(structureNodes, view, selectedStructureId, selectedModuleId),
    [selectedModuleId, selectedStructureId, structureNodes, view],
  );
  const activityDays = snapshot?.activity?.daily ?? [];
  const selectedActivityDay = activityDays.find((day) => day.date === selectedActivityDate);
  const activeModuleIds = selectedActivityDay?.active_modules ?? [];
  const appliedVisualEffects = useMemo<VisualEffects>(() => ({
    ...visualEffects,
    particles: visualEffects.particles && effectDistance === "near",
    clouds: visualEffects.clouds && effectDistance === "far",
  }), [effectDistance, visualEffects]);
  const selectedActivityIndex = activityDays.findIndex((day) => day.date === selectedActivityDate);
  const growthProgress = activityDays.length
    ? Math.max(0.72, (selectedActivityIndex + 1) / activityDays.length)
    : 1;

  function enterSeed() {
    setView("seed");
    setSelectedModuleId("seed-memory");
    setFocusRevision((value) => value + 1);
    setDetailOpen(true);
    if (!selectedCardId) {
      setSelectedCardId(snapshot?.seed_memory.cards.find((card) => card.lifecycle === "active")?.id ?? "");
    }
  }

  async function toggleBgm() {
    setAudioError("");
    if (bgmEnabled) {
      setBgmEnabled(false);
      await bgm.current?.stop();
      setBgmActive(false);
      return;
    }
    try {
      bgm.current ??= new AmbientBgm();
      bgm.current.setVolume(musicVolume);
      const playing = await bgm.current.start(musicTrack);
      setBgmEnabled(true);
      setBgmActive(playing);
    } catch {
      setAudioError(t(locale, "audio.error"));
      setBgmActive(false);
    }
  }

  function focusModule(moduleId: string) {
    setView("overview");
    setSelectedModuleId(moduleId);
    setSelectedCardId("");
    setFocusRevision((value) => value + 1);
    setDetailOpen(true);
    setLifeStreamOpen(false);
  }

  function focusLifeEventModule(moduleId: string) {
    setView("overview");
    setSelectedModuleId(moduleId);
    setSelectedCardId("");
    setFocusRevision((value) => value + 1);
    setDetailOpen(false);
  }

  function inspectTimelineModule(moduleId: string) {
    setSelectedModuleId(moduleId);
    setSelectedCardId("");
    setFocusRevision((value) => value + 1);
    setDetailOpen(true);
  }

  function proposeCardChange(card: SeedCard) {
    setTreatment({
      target: { type: "seed_card", id: card.id, title: cardDisplayName(locale, card), summary: card.summary },
      intents: ["update", "merge", "archive", "diagnose"],
      initialIntent: "update",
    });
  }

  function proposeNewCard() {
    setTreatment({
      target: { type: "seed_card", id: "new-seed-card", title: t(locale, "treatment.create_title") },
      intents: ["create", "diagnose"],
      initialIntent: "create",
    });
  }

  function proposeModuleChange(module: ModuleHealth) {
    setTreatment({
      target: { type: "module", id: module.id, title: moduleName(locale, module.id, module.name), summary: moduleSummary(locale, module) },
      intents: ["diagnose", "update"],
      initialIntent: "diagnose",
    });
  }

  function enterStructure(nodeId: string) {
    if (!structureNodes.some((node) => node.id === nodeId)) return;
    setView("structure");
    setSelectedCardId("");
    setSelectedStructureId(nodeId);
    setFocusRevision((value) => value + 1);
    setDetailOpen(true);
  }

  function leaveDepthView() {
    if (view === "structure" && structureNavigation.parentNode) {
      enterStructure(structureNavigation.parentNode.id);
      return;
    }
    setView("overview");
    setSelectedCardId("");
    setSelectedStructureId(snapshot?.structure?.root_id ?? "canopy-shell");
    setFocusRevision((value) => value + 1);
    setDetailOpen(false);
  }

  function toggleHud(area: "left" | "bottom") {
    setCompactHud((current) => ({ ...current, [area]: !current[area] }));
  }

  function toggleLifeStream() {
    if (!lifeStreamOpen) {
      setDetailOpen(false);
      setSettingsOpen(false);
    }
    setLifeStreamOpen(!lifeStreamOpen);
  }

  if (loading && !snapshot) return <LoadingScreen locale={locale} />;
  if (!snapshot) {
    return (
      <main className="fatal-state"><TreePine size={38} /><h1>{t(locale, "fatal.title")}</h1><p>{error}</p><button onClick={() => void load(true)}>{t(locale, "common.retry")}</button></main>
    );
  }

  return (
    <main
      className="app-shell"
      data-view={view}
      data-background={backgroundMode}
      data-settings={settingsOpen ? "open" : "closed"}
      data-life-stream={lifeStreamOpen ? "open" : "closed"}
      data-detail={detailOpen ? "open" : "closed"}
      data-effects={visualEffects.master ? "on" : "off"}
      data-effect-distance={effectDistance}
      data-effect-particles={appliedVisualEffects.master && appliedVisualEffects.particles ? "on" : "off"}
      data-effect-flow={appliedVisualEffects.master && appliedVisualEffects.flow ? "on" : "off"}
      data-effect-clouds={appliedVisualEffects.master && appliedVisualEffects.clouds ? "on" : "off"}
      data-effect-glow={appliedVisualEffects.master && appliedVisualEffects.glow ? "on" : "off"}
      data-effect-motion={appliedVisualEffects.master && appliedVisualEffects.motion ? "on" : "off"}
      data-effect-particles-preference={visualEffects.particles ? "on" : "off"}
      data-effect-clouds-preference={visualEffects.clouds ? "on" : "off"}
      lang={locale}
    >
      <div
        className="scene-stage"
        aria-label={t(locale, "aria.scene")}
        data-architecture-connections={connections.length}
        data-world-tree={backgroundMode === "none" ? "none" : backgroundMode}
        data-ancient-ruins={backgroundMode === "detailed" ? "visible" : "hidden"}
      >
        <CanopyScene
          modules={snapshot.modules}
          connections={connections}
          cards={snapshot.seed_memory.cards}
          structure={snapshot.structure}
          locale={locale}
          backgroundMode={backgroundMode}
          visualEffects={appliedVisualEffects}
          view={view === "timeline" ? "overview" : view}
          selectedModuleId={selectedModuleId}
          selectedCardId={selectedCardId}
          selectedStructureId={selectedStructureId}
          focusRevision={focusRevision}
          activeModuleIds={activeModuleIds}
          growthProgress={growthProgress}
          onSelectModule={focusModule}
          onSelectCard={(cardId) => { setSelectedCardId(cardId); setDetailOpen(true); }}
          onSelectStructure={enterStructure}
          onSceneInteraction={() => {
            setDetailOpen(false);
            setLifeStreamOpen(false);
          }}
          onEffectDistanceChange={setEffectDistance}
        />
      </div>

      <header className="top-hud">
        <div className="brand-lockup"><TreePine size={22} /><div><strong>CANOPY</strong><span>{t(locale, "brand.subtitle")}</span></div></div>
      </header>

      {view === "overview" && (
        <div className="topology-projection-badge" role="note">
          <GitBranch size={13} />
          <span><strong>{t(locale, "topology.projection_title")}</strong>{t(locale, "topology.projection_note")}</span>
        </div>
      )}

      <nav className="left-dock" aria-label={t(locale, "aria.navigation")} data-compact={compactHud.left ? "true" : "false"}>
        <button className="dock-density-toggle" aria-label={t(locale, compactHud.left ? "hud.expand" : "hud.compact")} title={t(locale, compactHud.left ? "hud.expand" : "hud.compact")} onClick={() => toggleHud("left")}>{compactHud.left ? <Maximize2 size={16} /> : <Minimize2 size={16} />}<span>{t(locale, compactHud.left ? "hud.expand_short" : "hud.compact_short")}</span></button>
        <button aria-label={t(locale, "nav.overview")} title={t(locale, "nav.overview")} className={view === "overview" ? "is-active" : ""} onClick={() => { setView("overview"); setSelectedModuleId(""); setSelectedCardId(""); setFocusRevision((value) => value + 1); setDetailOpen(false); }}><Home size={19} /><span>{t(locale, "nav.overview")}</span></button>
        <button aria-label={t(locale, "card.enter_roots")} title={t(locale, "nav.roots")} className={view === "seed" ? "is-active" : ""} onClick={enterSeed}><Sprout size={19} /><span>{t(locale, "nav.roots")}</span><em className="dock-count">{snapshot.seed_memory.active_count}</em></button>
        <button aria-label={t(locale, "structure.enter")} title={t(locale, "structure.enter")} className={view === "structure" ? "is-active" : ""} onClick={() => enterStructure(snapshot.structure?.root_id ?? "canopy-shell")}><FolderTree size={19} /><span>{t(locale, "nav.structure")}</span></button>
        <button aria-label={t(locale, "nav.timeline")} title={t(locale, "nav.timeline")} className={view === "timeline" ? "is-active" : ""} onClick={() => { setView("timeline"); setSelectedCardId(""); setDetailOpen(false); setActivityPlaying(false); }}><CalendarDays size={19} /><span>{t(locale, "nav.timeline")}</span></button>
        <button aria-label={t(locale, "nav.sync_detail")} title={t(locale, "nav.sync_detail")} onClick={() => void synchronizeLivingSystem()} disabled={refreshing}><RefreshCw size={19} className={refreshing ? "spin" : ""} /><span>{t(locale, "nav.refresh")}</span></button>
        <button aria-label={t(locale, bgmEnabled ? "nav.bgm_on" : "nav.bgm_off")} title={t(locale, bgmEnabled ? "nav.bgm_on" : "nav.bgm_off")} aria-pressed={bgmEnabled} className={bgmEnabled ? "is-active" : ""} data-playing={bgmActive ? "true" : "false"} onClick={() => void toggleBgm()}>{bgmEnabled ? <Volume2 size={19} /> : <VolumeX size={19} />}<span>BGM</span></button>
        <button aria-label={t(locale, "nav.settings")} title={t(locale, "nav.settings")} aria-pressed={settingsOpen} className={settingsOpen ? "is-active" : ""} onClick={() => { setSettingsOpen((value) => !value); setDetailOpen(false); }}><Settings2 size={19} /><span>{t(locale, "nav.settings")}</span></button>
      </nav>

      {settingsOpen && (
        <SettingsPanel
          locale={locale}
          backgroundMode={backgroundMode}
          musicTrack={musicTrack}
          musicVolume={musicVolume}
          soundEffects={soundEffects}
          soundEffectVolume={soundEffectVolume}
          visualEffects={visualEffects}
          effectDistance={effectDistance}
          onLocale={setLocale}
          onBackground={setBackgroundMode}
          onMusic={setMusicTrack}
          onMusicVolume={setMusicVolume}
          onSoundEffects={setSoundEffects}
          onSoundEffectVolume={setSoundEffectVolume}
          onVisualEffects={setVisualEffects}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {view === "seed" && <SeedNavigator cards={snapshot.seed_memory.cards} selectedId={selectedCardId} locale={locale} onSelect={(cardId) => { setSelectedCardId(cardId); setDetailOpen(true); }} onCreate={proposeNewCard} />}
      {view === "structure" && <StructureBreadcrumb nodes={structureNodes} selectedId={selectedStructureId} locale={locale} onSelect={enterStructure} />}
      {view === "timeline" && snapshot.activity && (
        <ActivityTimeline
          activity={snapshot.activity}
          modules={snapshot.modules}
          locale={locale}
          selectedDate={selectedActivityDate}
          playing={activityPlaying}
          onSelectedDate={(date) => { setSelectedActivityDate(date); setActivityPlaying(false); }}
          onTogglePlayback={() => setActivityPlaying((value) => !value)}
          onSelectModule={inspectTimelineModule}
        />
      )}

      <LifeStreamPanel
        events={lifeEvents.length ? lifeEvents : snapshot.activity?.events ?? []}
        sync={lifeSync}
        stats={lifeStats}
        retentionDays={lifeRetentionDays}
        locale={locale}
        open={lifeStreamOpen}
        onToggle={toggleLifeStream}
        onSelectModule={(moduleId) => {
          if (snapshot.modules.some((module) => module.id === moduleId)) focusLifeEventModule(moduleId);
        }}
        onOpenTimeline={() => {
          setView("timeline");
          setSelectedCardId("");
          setDetailOpen(false);
          setActivityPlaying(false);
        }}
      />

      {detailOpen && <DetailPanel
        module={view === "overview" || view === "timeline" ? selectedModule : undefined}
        card={view === "seed" ? selectedCard : undefined}
        structureNode={view === "structure" ? selectedStructureNode : undefined}
        structureNodes={structureNodes}
        structureNavigation={structureNavigation}
        connections={connections}
        activity={snapshot.activity}
        locale={locale}
        onEnterSeed={enterSeed}
        onEnterStructure={enterStructure}
        onTreatCard={proposeCardChange}
        onTreatModule={proposeModuleChange}
        onSelectModule={(moduleId) => { setView("overview"); focusModule(moduleId); }}
        onSelectStructure={enterStructure}
        onLeaveStructure={leaveDepthView}
        onClose={() => setDetailOpen(false)}
      />}

      <footer className="bottom-hud" data-compact={compactHud.bottom ? "true" : "false"}>
        <button className="hud-density-toggle bottom-density-toggle" aria-label={t(locale, compactHud.bottom ? "hud.expand" : "hud.compact")} title={t(locale, compactHud.bottom ? "hud.expand" : "hud.compact")} onClick={() => toggleHud("bottom")}>{compactHud.bottom ? <Maximize2 size={15} /> : <Minimize2 size={15} />}</button>
        <button className="depth-back" disabled={view === "overview"} onClick={leaveDepthView}><ArrowLeft size={17} />{view === "structure" && structureNavigation.parentNode ? t(locale, "structure.back") : view === "seed" ? t(locale, "footer.back_greenhouse") : t(locale, "footer.overview")}</button>
        <div className="signal-strip">
          {snapshot.issues.length ? snapshot.issues.slice(0, 3).map((issue, index) => (
            <span key={`${issue.title}-${index}`}><i data-status={issue.severity} />{localizedIssueTitle(locale, issue)}</span>
          )) : <span><i data-status="healthy" />{t(locale, "footer.no_major_issue")}</span>}
        </div>
        <div className="bottom-compact-summary"><i data-status={snapshot.issues[0]?.severity ?? "healthy"} /><strong>{t(locale, "footer.issue_count", { count: snapshot.issues.length })}</strong></div>
        <div className="global-vitals bottom-vitals">
          <StatusPill status={snapshot.overall.status} locale={locale} />
          <span><small>{t(locale, "metric.structural")}</small><strong>{snapshot.overall.scores.structural ?? "-"}</strong></span>
          <span><small>{t(locale, "metric.behavioral")}</small><strong>{snapshot.overall.scores.behavioral ?? "-"}</strong></span>
        </div>
        <time dateTime={snapshot.generated_at}>{new Date(snapshot.generated_at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}</time>
      </footer>

      <div className="health-legend" aria-label={t(locale, "aria.health_legend")}>
        {(["healthy", "attention", "critical", "unknown"] as HealthStatus[]).map((status) => <span key={status}><i data-status={status} />{t(locale, `status.${status}`)}</span>)}
      </div>

      {syncNotice && <div className="toast-sync" role="status">{syncNotice}</div>}
      {(error || audioError) && <div className="toast-error">{audioError || error}</div>}
      {treatment && <TreatmentComposer target={treatment.target} intents={treatment.intents} initialIntent={treatment.initialIntent} locale={locale} onClose={() => setTreatment(null)} />}
      <span className="sr-only" data-testid="architecture-count">{connections.length}</span>
    </main>
  );
}
