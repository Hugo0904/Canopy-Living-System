import type {
  ActivityEvent,
  LifeStory,
  LifeStoryIntervention,
  LifeStoryLearningEvidence,
} from "./types";

const GENERIC_RESULT_SUMMARIES = new Set([
  "AI 已整理本次協助結果。",
  "AI 已完成協助。",
  "AI 已完成協助，Canopy 也完成必要的收尾驗證。",
  "AI completed this turn.",
]);

const TERMINAL_STATUSES = new Set(["completed", "applied", "not_applied", "blocked", "failed", "interrupted"]);
const FAILURE_STATUSES = ["failed", "blocked", "interrupted", "attention"];
const CONCRETE_SUMMARY_KINDS = new Set(["assistant_result", "seed_action", "seed_intake", "miss_analysis", "task"]);

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function usefulSummary(event: ActivityEvent | undefined): string {
  if (!event) return "";
  const summary = clean(event.summary);
  return GENERIC_RESULT_SUMMARIES.has(summary) ? "" : summary;
}

function lastOf(events: ActivityEvent[], predicate: (event: ActivityEvent) => boolean): ActivityEvent | undefined {
  return [...events].reverse().find(predicate);
}

function uniqueEvents(events: ActivityEvent[]): ActivityEvent[] {
  const bySemanticStep = new Map<string, ActivityEvent>();
  events.forEach((event) => {
    const key = [event.kind, event.action, event.status, usefulSummary(event), clean(event.verification)].join("\u0000");
    bySemanticStep.set(key, event);
  });
  return [...bySemanticStep.values()].sort((left, right) => left.occurred_at.localeCompare(right.occurred_at));
}

function primaryEvent(events: ActivityEvent[]): ActivityEvent {
  const priorities = [
    (event: ActivityEvent) => event.kind === "assistant_result" && Boolean(usefulSummary(event)),
    (event: ActivityEvent) => event.kind === "seed_action" && Boolean(usefulSummary(event)),
    (event: ActivityEvent) => event.kind === "seed_intake" && Boolean(usefulSummary(event)),
    (event: ActivityEvent) => event.kind === "miss_analysis" && Boolean(usefulSummary(event)),
    (event: ActivityEvent) => event.kind === "task" && Boolean(usefulSummary(event)),
    (event: ActivityEvent) => Boolean(usefulSummary(event)),
  ];
  for (const predicate of priorities) {
    const matched = lastOf(events, predicate);
    if (matched) return matched;
  }
  return events[events.length - 1];
}

function storyStatus(events: ActivityEvent[], primary: ActivityEvent): string {
  for (const status of FAILURE_STATUSES) {
    if (events.some((event) => event.status === status)) return status;
  }
  if (events.some((event) => TERMINAL_STATUSES.has(event.status))) {
    return primary.status === "not_applied" ? "completed" : primary.status || "completed";
  }
  return events.some((event) => event.status === "in_progress") ? "in_progress" : primary.status;
}

function storyLearning(events: ActivityEvent[], status: string): LifeStoryLearningEvidence {
  const intake = lastOf(events, (event) => event.kind === "seed_intake");
  if (intake) {
    const intakeState = clean(intake.growth_stage || intake.status || intake.action);
    const learned = ["active", "active_card_created"].includes(intakeState);
    const candidate = ["candidate", "candidate_card_created", "project_rule_required"].includes(intakeState);
    return {
      mode: learned ? "learned" : candidate ? "candidate" : "reviewing",
      stage: learned ? "active" : candidate ? "candidate" : intakeState || "observed",
      summary: clean(intake.learning) || usefulSummary(intake),
      next_benefit: clean(intake.next_benefit),
      evidence_kind: "seed_intake",
    };
  }

  const seedAction = lastOf(events, (event) => event.kind === "seed_action");
  if (seedAction) {
    const applied = seedAction.status === "applied";
    return {
      mode: applied ? "applied" : "reviewed",
      stage: applied ? "applied" : "reviewed",
      summary: clean(seedAction.learning) || usefulSummary(seedAction),
      next_benefit: applied ? clean(seedAction.next_benefit) : "",
      evidence_kind: "seed_action",
    };
  }

  const miss = lastOf(events, (event) => event.kind === "miss_analysis");
  if (miss) {
    const resolved = miss.status === "resolved" || miss.growth_stage === "resolved";
    return {
      mode: resolved ? "resolved" : "reviewing",
      stage: resolved ? "resolved" : "observed",
      summary: clean(miss.learning) || usefulSummary(miss),
      next_benefit: clean(miss.next_benefit),
      evidence_kind: "miss_analysis",
    };
  }

  if (FAILURE_STATUSES.includes(status)) {
    return { mode: "incomplete", stage: "incomplete", summary: "", next_benefit: "", evidence_kind: "" };
  }
  return { mode: "none", stage: "none", summary: "", next_benefit: "", evidence_kind: "" };
}

function storyInterventions(events: ActivityEvent[]): LifeStoryIntervention[] {
  const interventions: LifeStoryIntervention[] = [];
  const turnEvidence = lastOf(events, (event) => event.kind === "turn" && event.action === "turn_opened")
    ?? lastOf(events, (event) => event.kind === "turn");
  const role = clean(turnEvidence?.facts?.role);
  if (role && role !== "unreported" && turnEvidence?.facts?.role_status === "selected") {
    interventions.push({ kind: "role_selected", value: role, summary: "" });
  }
  if (turnEvidence?.facts?.prior_context_used === "true") {
    interventions.push({ kind: "prior_context", value: "true", summary: "" });
  }
  if (turnEvidence?.facts?.evolution === "required") {
    interventions.push({ kind: "evolution_review", value: "required", summary: "" });
  }
  const seedAction = lastOf(events, (event) => event.kind === "seed_action");
  if (seedAction) {
    interventions.push({
      kind: seedAction.status === "applied" ? "memory_applied" : "memory_reviewed",
      value: seedAction.status,
      summary: usefulSummary(seedAction),
    });
  }
  return interventions;
}

function storyVerifications(events: ActivityEvent[]): Array<{ kind: string; text: string }> {
  const results: Array<{ kind: string; text: string }> = [];
  const seen = new Set<string>();
  const hasClosure = events.some((event) => event.kind === "turn" && event.action === "turn_completed");
  events.forEach((event) => {
    const text = clean(event.verification);
    if (!text || seen.has(text)) return;
    if (hasClosure && event.kind === "turn" && event.action === "turn_opened") return;
    if (event.kind === "assistant_result" && events.some((candidate) => candidate.kind === "turn" && candidate.action === "turn_completed")) return;
    seen.add(text);
    results.push({ kind: event.kind, text });
  });
  return results.slice(-4);
}

export function buildLifeStories(rawEvents: ActivityEvent[]): LifeStory[] {
  const groups = new Map<string, ActivityEvent[]>();
  rawEvents.forEach((event) => {
    const correlation = clean(event.correlation_id);
    const key = correlation && correlation !== "turn:unreported" ? correlation : `event:${event.id}`;
    groups.set(key, [...(groups.get(key) ?? []), event]);
  });

  return [...groups.entries()].map(([correlation, groupedEvents]) => {
    const events = uniqueEvents(groupedEvents);
    const primary = primaryEvent(events);
    const status = storyStatus(events, primary);
    const outcomeEvent = lastOf(events, (event) => event.kind === "assistant_result" && Boolean(usefulSummary(event)))
      ?? lastOf(events, (event) => event.kind === "task" && Boolean(usefulSummary(event)));
    const outcome = usefulSummary(outcomeEvent);
    const summary = outcome || usefulSummary(primary);
    const moduleEvent = lastOf(events, (event) => Boolean(event.module_id) && !["hooks", "canopy"].includes(event.module_id));
    const factsEvent = lastOf(events, (event) => event.kind === "turn") ?? primary;
    const learning = storyLearning(events, status);
    const evolutionRequested = events.some((event) => event.facts?.evolution === "required");
    return {
      id: `story:${correlation}`,
      correlation_id: correlation.startsWith("event:") ? primary.correlation_id : correlation,
      occurred_at: events[events.length - 1].occurred_at,
      module_id: moduleEvent?.module_id || primary.module_id,
      phase: FAILURE_STATUSES.includes(status)
        ? "protection"
        : ["in_progress", "running"].includes(status)
          ? "running"
          : learning.mode !== "none"
            ? "growth"
            : "completed",
      status,
      summary,
      outcome,
      primary_kind: primary.kind,
      facts: factsEvent.facts ?? {},
      interventions: storyInterventions(events),
      verifications: storyVerifications(events),
      learning,
      evolution_requested: evolutionRequested,
      steps: events.slice(-8),
    };
  }).sort((left, right) => right.occurred_at.localeCompare(left.occurred_at));
}

export function eventPayloadRevision(events: ActivityEvent[], stats: { total: number; newest: string }): string {
  if ("revision" in stats && typeof stats.revision === "string" && stats.revision) return stats.revision;
  const newest = events[0];
  return [stats.total, stats.newest, newest?.id ?? "", newest?.status ?? "", newest?.summary ?? ""].join("|");
}

export function preferredStepSummary(event: ActivityEvent): string {
  if (CONCRETE_SUMMARY_KINDS.has(event.kind)) return usefulSummary(event) || clean(event.assistance);
  return usefulSummary(event) || clean(event.assistance);
}
