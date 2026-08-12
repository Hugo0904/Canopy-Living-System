export type HealthStatus = "healthy" | "attention" | "critical" | "unknown";

export interface StatusDimension {
  status: string;
  label: string;
  reason?: string;
}

export interface ModuleHealth {
  id: string;
  name: string;
  zone: string;
  summary: string;
  health: StatusDimension & { status: HealthStatus };
  activity: StatusDimension;
  impact: StatusDimension;
  confidence: { level: string; label: string };
  metrics: Record<string, string | number | boolean | null | undefined>;
}

export interface ActivityEvent {
  id: string;
  occurred_at: string;
  local_date: string;
  module_id: string;
  kind: "turn" | "task" | "seed_action" | "seed_intake" | "miss_analysis" | string;
  status: string;
  summary: string;
  source: string;
  importance: number;
  facts: Record<string, string>;
  phase: string;
  actor: string;
  correlation_id: string;
  action: string;
  growth_stage: string;
  learning: string;
  next_benefit: string;
  assistance: string;
  request_effect: string;
  verification: string;
}

export interface ActivityDay {
  date: string;
  total: number;
  active_modules: string[];
  module_counts: Record<string, number>;
  importance: number;
}

export interface ActivityMilestone {
  id: string;
  event_id: string;
  occurred_at: string;
  local_date: string;
  module_id: string;
  kind: string;
  summary: string;
  importance: number;
}

export interface ActivityProjection {
  schema_version: number;
  contract_id: string;
  window: { days: number; from: string; to: string };
  limits: Record<string, unknown>;
  privacy: Record<string, boolean>;
  events: ActivityEvent[];
  daily: ActivityDay[];
  milestones: ActivityMilestone[];
  modules: Record<string, { total_in_window: number; last_activity_at: string; event_ids: string[] }>;
  source_counts: Record<string, number>;
  omitted: Record<string, unknown>;
  truncated: boolean;
  coverage?: Record<string, unknown>;
  sync_cursor?: string;
}

export interface LifeEventsResponse {
  schema_version: number;
  contract_id: string;
  events: ActivityEvent[];
  stats: { total: number; oldest: string; newest: string };
  retention_days: number;
  sync: {
    status: "starting" | "live" | "degraded" | string;
    last_synced_at: string;
    last_error: string;
    accepted: number;
    persisted: number;
    coverage?: Record<string, unknown>;
  };
}

export interface SeedCard {
  id: string;
  title: string;
  category: string;
  lifecycle: string;
  status: string;
  scope: string;
  summary: string;
  source_type: string;
  source_summary: string;
  encouragement: string;
  reflection_question: string;
  triggers: string[];
  review_after: string;
  created_at: string;
  health: { status: HealthStatus; reason: string };
}

export interface CanopyIssue {
  severity: HealthStatus;
  code?: string;
  params?: Record<string, string | number | boolean>;
  title: string;
  detail: string;
}

export interface CanopyConnection {
  id: string;
  source: string;
  target: string;
  phase: "preflight" | "postflight" | "learning" | "evolution" | "maintenance" | string;
  label_key: string;
  description_key: string;
  health: {
    status: HealthStatus;
    reason: string;
  };
  signal: {
    state: string;
    strength: number;
    semantics: string;
  };
}

export type StructureNodeKind = "canopy" | "landmark" | "organ" | "system" | "tissue" | "component";

export interface StructureNode {
  id: string;
  parent_id: string;
  kind: StructureNodeKind;
  module_id: string;
  name: string;
  path: string;
  summary: string;
  size_bytes: number;
  child_count: number;
  dependencies: string[];
}

export interface StructureEdge {
  source: string;
  target: string;
  relation: "contains" | "feeds" | "depends_on" | string;
}

export interface CanopyStructure {
  schema_version: number;
  contract_id: string;
  root_id: string;
  nodes: StructureNode[];
  edges: StructureEdge[];
  truncated: boolean;
  limits: {
    max_nodes: number;
    max_summary_chars: number;
    max_file_read_bytes: number;
  };
}

export interface CanopySnapshot {
  schema_version: number;
  generated_at: string;
  source_mode: string;
  canopy: {
    name: string;
    root: string;
    doctor_status: HealthStatus;
    version: string;
  };
  runtime: {
    engine: string;
    model: string;
    reasoning_effort: string;
    identity_source: string;
  };
  overall: {
    status: HealthStatus;
    summary: string;
    scores: Record<string, number | null | undefined>;
  };
  modules: ModuleHealth[];
  topology?: {
    schema_version: number;
    contract_id: string;
    signal_semantics: string;
    structure_contract_id?: string;
  };
  connections: CanopyConnection[];
  structure?: CanopyStructure;
  activity?: ActivityProjection;
  seed_memory: {
    cards: SeedCard[];
    active_count: number;
    candidate_count: number;
    archived_count: number;
  };
  roles: Array<Record<string, unknown>>;
  resources: Record<string, unknown>;
  issues: CanopyIssue[];
  capabilities: {
    card_proposals: boolean;
    direct_card_mutation: boolean;
    codex_bridge: string;
    core_mutation: boolean;
  };
}

export interface TreatmentRequest {
  id: string;
  request_type: string;
  target_type: string;
  target_id: string;
  intent: string;
  operator_prompt: string;
  status: string;
  proposal: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface TreatmentTarget {
  type: "seed_card" | "module" | "agent" | "receipt" | "log";
  id: string;
  title: string;
  summary?: string;
}
