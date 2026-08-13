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
  health: StatusDimension & {
    status: HealthStatus;
    reason_code?: string;
    evidence_state?: string;
  };
  activity: StatusDimension;
  impact: StatusDimension;
  confidence: { level: string; label: string };
  metrics: Record<string, string | number | boolean | null | undefined>;
  issue_ids?: string[];
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

export type LifeStoryInterventionKind =
  | "role_selected"
  | "prior_context"
  | "evolution_review"
  | "memory_applied"
  | "memory_reviewed";

export interface LifeStoryIntervention {
  kind: LifeStoryInterventionKind;
  value: string;
  summary: string;
}

export interface LifeStoryLearningEvidence {
  mode: "learned" | "candidate" | "applied" | "reviewed" | "reviewing" | "resolved" | "incomplete" | "none";
  stage: string;
  summary: string;
  next_benefit: string;
  evidence_kind: string;
}

export interface LifeStory {
  id: string;
  correlation_id: string;
  occurred_at: string;
  module_id: string;
  phase: string;
  status: string;
  summary: string;
  outcome: string;
  primary_kind: string;
  facts: Record<string, string>;
  interventions: LifeStoryIntervention[];
  verifications: Array<{ kind: string; text: string }>;
  learning: LifeStoryLearningEvidence;
  evolution_requested: boolean;
  steps: ActivityEvent[];
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
  stats: { total: number; oldest: string; newest: string; revision?: string };
  retention_days: number;
  sync: {
    status: "starting" | "live" | "degraded" | string;
    last_synced_at: string;
    last_error: string;
    accepted: number;
    persisted: number;
    coverage?: Record<string, unknown>;
    truncated?: boolean;
    omitted?: Record<string, unknown>;
  };
}

export interface LifeEventsRevisionResponse {
  schema_version: number;
  contract_id: string;
  stats: LifeEventsResponse["stats"];
  sync: LifeEventsResponse["sync"];
}

export type FuraGuidanceStatus = "available" | "quiet" | "unavailable";
export type FuraGuidanceKind = "issue" | "question" | "daily";
export type FuraGuidanceAction = "inspect" | "diagnose" | "answer" | "source" | "snooze" | "dismiss" | "open_notebook";

export interface FuraGuidanceMessage {
  id: string;
  fingerprint: string;
  kind: FuraGuidanceKind;
  title: string;
  body: string;
  source_owner: string;
  observed_at: string;
  claim_status: "core_evidence" | "operator_question" | "external_verified";
  target?: {
    type: "issue" | "seed_card" | "daily";
    id: string;
    module_ids?: string[];
    category?: string;
    source_name?: string;
    source_url?: string;
  };
  requestable: boolean;
  evidence: string[];
  actions: FuraGuidanceAction[];
}

export interface FuraGuidanceResponse {
  schema_version: number;
  contract_id: string;
  status: FuraGuidanceStatus;
  message: FuraGuidanceMessage | null;
  reason?: string;
}

export interface FuraGuidanceDecisionResponse {
  schema_version: number;
  contract_id: string;
  status: string;
  message_id: string;
  decision: "snooze" | "dismiss";
  snoozed_until?: string;
}

export interface FuraGuidanceAnswerResponse {
  status: "awaiting_ai_review" | string;
  message_id: string;
  treatment: TreatmentRequest;
  provenance: {
    operator_evidence: "operator_explicit";
    ai_inferred_candidate: null;
    distillation_status: "awaiting_ai_review";
  };
}

export interface SnapshotRevisionResponse {
  schema_version: number;
  contract_id: string;
  generated_at: string;
  sync: SnapshotSyncState;
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
  id?: string;
  source?: string;
  state?: string;
  owner?: string;
  impact?: string;
  evidence_state?: string;
  requires_operator?: boolean;
  case_id?: string;
  last_seen_at?: string;
  next_review_at?: string;
  severity: HealthStatus;
  code?: string;
  params?: Record<string, string | number | boolean>;
  title: string;
  detail: string;
  module_ids?: string[];
  evidence?: string[];
  source_refs?: string[];
  remediation?: {
    mode?: string;
    state?: string;
    action_id?: string;
    authority?: string;
    automatic?: boolean;
    requestable?: boolean;
    summary?: string;
    next_action?: string;
    command?: string;
    verification?: string;
    rollback?: string;
  };
  verification?: {
    status?: string;
    summary?: string;
    verified_at?: string;
  } | string;
}

export type RemediationMode = "embedded" | "handoff";

export interface RemediationModelCapability {
  model: string;
  display_name: string;
  efforts: string[];
  default_effort?: string | null;
  is_default: boolean;
}

export interface RemediationCapabilities {
  status: string;
  available: boolean;
  models: RemediationModelCapability[];
  error_code?: string | null;
  error?: string | null;
}

export interface RemediationDiagnosis {
  summary?: string;
  root_cause?: string;
  evidence?: string[];
  recommended_action?: string;
  affected_scope?: string[];
  risk?: "low" | "medium" | "high" | string;
  verification_plan?: string[];
  requires_operator_input?: boolean;
  operator_question?: string | null;
  engineering_verdict?: "PASS" | "REVISE" | "OBSERVE" | "REJECT" | string;
  invariant_results?: Record<string, string>;
  review_risks?: string[];
  review_rationale?: string;
}

export interface RemediationArtifact {
  artifact_type?: string;
  verdict?: string;
  invariant_results?: Record<string, string>;
  risks?: string[];
  rationale?: string;
  [key: string]: unknown;
}

export interface RemediationRecord {
  id: string;
  contract_id?: string;
  contract_version?: string;
  finding_id: string;
  finding_fingerprint?: string;
  origin?: string;
  mode?: string;
  stage: string;
  case_id?: string;
  proposal_id?: string;
  proposal_hash?: string;
  requested_model?: string;
  requested_reasoning_effort?: string;
  applied_model?: string;
  applied_reasoning_effort?: string;
  finding?: {
    id?: string;
    owner?: string;
    summary?: string;
    evidence?: string[];
    source_refs?: string[];
    remediation?: Record<string, string>;
  };
  diagnosis?: RemediationDiagnosis;
  artifacts?: Record<string, RemediationArtifact>;
  authorization?: {
    id?: string;
    decision?: string;
    authority?: string;
    proposal_hash?: string;
    decided_at?: string;
  };
  execution?: {
    status?: string;
    model?: string;
    effort?: string;
    output?: {
      summary?: string;
      changed_paths?: string[];
      verification_evidence?: string[];
      remaining_risks?: string[];
    };
    error?: string | null;
  };
  verification?: {
    outcome?: "resolved" | "still_open" | "issue_changed" | "unavailable" | string;
    summary?: string;
    verified_at?: string;
  };
  created_at?: string;
  updated_at?: string;
}

export interface RemediationResponse {
  status: string;
  request?: RemediationRecord;
  provider?: {
    status?: string;
    model?: string | null;
    effort?: string | null;
    error_code?: string | null;
    error?: string | null;
  };
  verification_error?: string;
}

export interface RemediationHandoff {
  status: string;
  request_id: string;
  stage?: string;
  cli: {
    inspect: string;
    continue: string;
  };
  desktop_prompt: string;
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

export interface TopologySyncReport {
  status: "valid" | "unavailable" | string;
  fingerprint: string;
  contract_id: string;
  schema_version: number;
  module_count: number;
  connection_count: number;
  structure_node_count: number;
}

export interface SnapshotSyncState {
  status: "starting" | "live" | "degraded" | string;
  last_synced_at: string;
  last_error: string;
  changed: boolean;
  observation_state: "observed" | "no_data" | "contract_invalid";
  projection_state: "current" | "last_known_good" | "unavailable";
  using_last_verified: boolean;
  contract: {
    status: "valid" | "unavailable" | string;
    schema_version: number;
    source_mode: string;
    module_count: number;
  };
  topology: TopologySyncReport;
}

export interface SyncSnapshotResponse {
  snapshot: CanopySnapshot;
  sync: SnapshotSyncState;
}

export interface EvolutionLabContract {
  status?: string;
  health?: string;
  version?: string;
  routing_cases?: number;
  runtime_chars?: number;
  runtime_target_chars?: number;
}

export interface EvolutionLabFinding {
  id: string;
  event?: string;
  status?: string;
  priority?: string;
  owner?: string;
  category?: string;
  summary?: string;
  suggested_improvement?: string;
  evidence?: string[];
  evidence_truncated?: boolean;
  case_id?: string;
  case?: {
    case_id?: string;
    current_state?: string;
    target_outcome?: string;
  };
}

export interface EvolutionLabWorkflowStep {
  id: string;
  label?: string;
  state?: string;
  status?: string;
  reached_state?: string;
  evidence_status?: string;
  basis?: string;
  artifact_count?: number;
}

export interface EvolutionLabCaseCandidate {
  artifact_type?: string;
  artifact_status?: string;
  artifact_persisted?: boolean;
  artifact_persistence?: string;
  case_id?: string;
  trigger_source?: string;
  problem?: string;
  scope?: string;
  evidence?: string[];
  evidence_truncated?: boolean;
  constraints?: string[];
  constraints_truncated?: boolean;
  reached_state?: string;
  target_outcome?: string;
}

export interface EvolutionLabResponse {
  status?: "available" | "unavailable" | string;
  generated_at?: string;
  contract?: EvolutionLabContract;
  summary?: Record<string, string | number | boolean | null | undefined>;
  monitor?: {
    health?: string;
    summary?: Record<string, string | number | boolean | null | undefined>;
  };
  findings?: EvolutionLabFinding[];
  findings_truncated?: boolean;
  findings_total?: number;
  findings_omitted?: number;
  workflow?: EvolutionLabWorkflowStep[];
  workflow_stages?: EvolutionLabWorkflowStep[];
  case_candidates?: EvolutionLabCaseCandidate[];
  case_candidates_truncated?: boolean;
  case_candidates_total?: number;
  case_candidates_omitted?: number;
  totals?: {
    findings?: number;
    case_candidates?: number;
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
  type: "seed_card" | "agent" | "receipt" | "log";
  id: string;
  title: string;
  summary?: string;
}
