import { useMemo, useState } from "react";
import {
  Activity,
  CheckCircle2,
  ChevronRight,
  ChevronUp,
  HeartPulse,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Wrench,
} from "lucide-react";
import { activityKind, activityStatus, t, type Locale } from "../i18n";
import { buildLifeStories, preferredStepSummary } from "../lifeStories";
import type { ActivityEvent, LifeEventsResponse, LifeStory, LifeStoryIntervention } from "../types";

type LifeFilter = "all" | "growth" | "protection";

interface LifeStreamPanelProps {
  events: ActivityEvent[];
  sync: LifeEventsResponse["sync"];
  stats: LifeEventsResponse["stats"];
  retentionDays: number;
  locale: Locale;
  open: boolean;
  onToggle: () => void;
  onSelectModule: (moduleId: string) => void;
  onOpenTimeline: () => void;
}

function phaseIcon(story: LifeStory) {
  if (story.learning.mode !== "none") return <Sparkles size={14} />;
  if (story.phase === "protection" || story.status === "blocked") return <ShieldCheck size={14} />;
  if (story.primary_kind === "tool") return <Wrench size={14} />;
  if (story.status === "completed" || story.status === "applied") return <CheckCircle2 size={14} />;
  return <Activity size={14} />;
}

function hasModel(story: LifeStory): string {
  const model = String(story.facts?.model ?? "");
  return model && model !== "unreported" ? model : "";
}

const VISIBLE_FACTS = [
  "model",
  "resolver_status",
  "matched_cards",
  "role",
  "evolution",
  "intent_status",
  "context_chars",
  "required_obligations",
  "missing_obligations",
] as const;

function roleLabel(locale: Locale, role: string): string {
  const names: Record<Locale, Record<string, string>> = {
    "zh-TW": { "senior-engineer": "資深工程師", "ui-ux-designer": "UI／UX 設計師", "ai-engineer": "AI 工程師" },
    "zh-CN": { "senior-engineer": "资深工程师", "ui-ux-designer": "UI／UX 设计师", "ai-engineer": "AI 工程师" },
    en: { "senior-engineer": "Senior Engineer", "ui-ux-designer": "UI/UX Designer", "ai-engineer": "AI Engineer" },
  };
  return names[locale][role] ?? role;
}

function interventionText(intervention: LifeStoryIntervention, locale: Locale): string {
  if (intervention.kind === "role_selected") {
    return t(locale, "life.intervention.role", { role: roleLabel(locale, intervention.value) });
  }
  if (intervention.kind === "prior_context") return t(locale, "life.intervention.context");
  if (intervention.kind === "evolution_review") return t(locale, "life.intervention.evolution");
  if (intervention.kind === "memory_applied") {
    return intervention.summary
      ? t(locale, "life.intervention.memory_applied_detail", { summary: intervention.summary })
      : t(locale, "life.intervention.memory_applied");
  }
  return intervention.summary
    ? t(locale, "life.intervention.memory_reviewed_detail", { summary: intervention.summary })
    : t(locale, "life.intervention.memory_reviewed");
}

function learningCopy(story: LifeStory, locale: Locale): { title: string; detail: string; next: string } {
  const evidence = story.learning;
  const fallbackDetail = t(locale, `life.learning.story_${evidence.mode}_detail`);
  return {
    title: t(locale, `life.learning.story_${evidence.mode}`),
    detail: evidence.summary || fallbackDetail,
    next: evidence.next_benefit,
  };
}

function omittedEvidenceCount(omitted: Record<string, unknown> | undefined): number {
  if (!omitted) return 0;
  const direct = ["malformed", "over_limit", "sensitive"].reduce((total, key) => total + (Number(omitted[key]) || 0), 0);
  const quotas = omitted.source_quota && typeof omitted.source_quota === "object"
    ? Object.values(omitted.source_quota as Record<string, unknown>).reduce<number>((total, value) => total + (Number(value) || 0), 0)
    : 0;
  return direct + quotas;
}

export function LifeStreamPanel({
  events,
  sync,
  stats,
  retentionDays,
  locale,
  open,
  onToggle,
  onSelectModule,
  onOpenTimeline,
}: LifeStreamPanelProps) {
  const [filter, setFilter] = useState<LifeFilter>("all");
  const [expandedStoryId, setExpandedStoryId] = useState("");
  const stories = useMemo(() => buildLifeStories(events), [events]);
  const visibleStories = useMemo(() => stories.filter((story) => {
    if (filter === "growth") return story.learning.mode !== "none" || story.evolution_requested;
    if (filter === "protection") return story.phase === "protection" || ["blocked", "failed", "interrupted"].includes(story.status);
    return true;
  }), [stories, filter]);
  const current = stories[0];
  const currentModel = current ? hasModel(current) : "";
  const omittedCount = omittedEvidenceCount(sync.omitted);

  function selectStory(story: LifeStory) {
    setExpandedStoryId((currentId) => currentId === story.id ? "" : story.id);
    onSelectModule(story.module_id);
  }

  if (!open) return null;

  return (
    <aside className="life-stream-panel fura-notebook" aria-label={t(locale, "aria.life_stream")} data-sync={sync.status} data-story-expanded={expandedStoryId ? "true" : "false"}>
      <header className="life-stream-heading">
        <div>
          <span className="fura-notebook-avatar" aria-hidden="true" />
          <span><small>{t(locale, "fura.notebook_eyebrow")}</small><strong>{t(locale, "fura.notebook_title")}</strong></span>
        </div>
        <div className="life-heading-actions">
          <span className="life-sync-state" data-status={sync.status}><i /><HeartPulse size={12} />{t(locale, `life.sync.${sync.status}`)}</span>
          <button className="icon-button" onClick={onToggle} aria-label={t(locale, "life.close")}><ChevronUp size={16} /></button>
        </div>
      </header>

      <section className="life-current" data-status={current?.status ?? "starting"}>
        <div className="life-current-label"><span className="life-pulse" data-status={current?.status ?? sync.status} />{t(locale, "life.current")}</div>
        <strong>{current?.summary || t(locale, "life.waiting")}</strong>
        <div>
          {current && <span>{activityStatus(locale, current.status)}</span>}
          {currentModel && <code>{currentModel}</code>}
          {current?.correlation_id && <small>{current.correlation_id.slice(-6).toUpperCase()}</small>}
        </div>
      </section>

      <div className="life-filters" role="group" aria-label={t(locale, "life.filter_label")}>
        {(["all", "growth", "protection"] as LifeFilter[]).map((value) => (
          <button key={value} className={filter === value ? "is-active" : ""} aria-pressed={filter === value} onClick={() => setFilter(value)}>
            {t(locale, `life.filter.${value}`)}
          </button>
        ))}
      </div>

      <div className="life-event-stream" aria-live="polite">
        {visibleStories.length ? visibleStories.slice(0, 24).map((story) => {
          const expanded = expandedStoryId === story.id;
          const facts = VISIBLE_FACTS
            .map((key) => [key, story.facts?.[key]] as const)
            .filter(([, value]) => value && value !== "unreported" && value !== "false");
          const learning = learningCopy(story, locale);
          return (
            <article key={story.id} className="life-event" data-story-id={story.id} data-kind="turn_story" data-phase={story.phase} data-status={story.status} data-expanded={expanded ? "true" : "false"}>
              <button className="life-event-main" onClick={() => selectStory(story)} aria-expanded={expanded}>
                <span className="life-event-icon">{phaseIcon(story)}</span>
                <span className="life-event-copy">
                  <span><time>{new Date(story.occurred_at).toLocaleString(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time><em>{t(locale, `life.phase.${story.phase}`)}</em></span>
                  <strong>{t(locale, "life.turn_story")}</strong>
                  <small>{story.summary || t(locale, "life.outcome_unavailable")}</small>
                </span>
                <span className="life-event-status">{activityStatus(locale, story.status)}<ChevronRight size={12} /></span>
              </button>
              {expanded && (
                <section className="life-event-details" aria-label={t(locale, "life.details")}>
                  <header><strong>{t(locale, "life.details")}</strong><small>{t(locale, "life.focus_note")}</small></header>

                  <div className="life-story-section" data-section="outcome">
                    <span>{t(locale, "life.ai_outcome")}</span>
                    <p>{story.outcome || t(locale, "life.outcome_unavailable")}</p>
                    {story.outcome && <small>{t(locale, "life.outcome_evidence_note")}</small>}
                  </div>

                  <div className="life-story-section" data-section="intervention">
                    <span>{t(locale, "life.canopy_intervention")}</span>
                    {story.interventions.length ? (
                      <ul>{story.interventions.map((intervention, index) => <li key={`${intervention.kind}:${index}`}>{interventionText(intervention, locale)}</li>)}</ul>
                    ) : <p>{t(locale, "life.intervention.baseline_only")}</p>}
                  </div>

                  <div className="life-story-section" data-section="verification">
                    <span>{t(locale, "life.verified")}</span>
                    {story.verifications.length ? (
                      <ul>{story.verifications.map((verification, index) => (
                        <li key={`${verification.kind}:${index}`}><strong>{activityKind(locale, verification.kind)}</strong>{verification.text}</li>
                      ))}</ul>
                    ) : <p>{t(locale, "life.verification_unavailable")}</p>}
                    <small>{t(locale, "life.verification_scope_note")}</small>
                  </div>

                  <div className="life-learning-status" data-mode={story.learning.mode}>
                    <span><Sparkles size={12} />{t(locale, "life.learning_status")}</span>
                    <strong>{learning.title}</strong>
                    <p>{learning.detail}</p>
                    {learning.next && <small><strong>{t(locale, "life.next_time")}</strong>{learning.next}</small>}
                    <em>{t(locale, `life.stage.${story.learning.stage}`)}</em>
                  </div>

                  {story.evolution_requested && (
                    <div className="life-evolution-status">
                      <span>{t(locale, "life.evolution_status")}</span>
                      <strong>{t(locale, "life.evolution_requested")}</strong>
                      <p>{t(locale, "life.evolution_requested_detail")}</p>
                    </div>
                  )}

                  {facts.length > 0 && <dl>{facts.map(([key, value]) => <div key={key}><dt>{t(locale, `life.fact.${key}`)}</dt><dd>{value}</dd></div>)}</dl>}
                  {story.steps.length > 1 && (
                    <div className="life-turn-steps">
                      <span>{t(locale, "life.turn_steps", { count: story.steps.length })}</span>
                      <ol>{story.steps.map((step) => (
                        <li key={step.id}><i data-status={step.status} /><span><strong>{activityKind(locale, step.kind)}</strong><small>{preferredStepSummary(step)}</small></span></li>
                      ))}</ol>
                    </div>
                  )}
                </section>
              )}
            </article>
          );
        }) : <div className="life-empty"><RefreshCw size={18} /><p>{t(locale, filter === "all" ? "life.no_events" : "life.no_filtered_events")}</p></div>}
      </div>

      <footer className="life-stream-footer">
        <button onClick={onOpenTimeline}>{t(locale, "life.open_calendar")}<ChevronRight size={13} /></button>
        <span>{t(locale, "life.retention", { count: retentionDays, total: stats.total, stories: stories.length })}</span>
        {(sync.truncated || omittedCount > 0) && <span className="life-coverage-note">{t(locale, "life.coverage_limited", { count: omittedCount })}</span>}
        <small>{t(locale, "life.privacy")}</small>
      </footer>
    </aside>
  );
}
