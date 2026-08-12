import { useMemo, useState } from "react";
import {
  Activity,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  HeartPulse,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Wrench,
} from "lucide-react";
import { activityKind, activityStatus, t, type Locale } from "../i18n";
import type { ActivityEvent, LifeEventsResponse } from "../types";

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

function phaseIcon(event: ActivityEvent) {
  if (event.phase === "growth" || event.growth_stage) return <Sparkles size={14} />;
  if (event.phase === "protection" || event.status === "blocked") return <ShieldCheck size={14} />;
  if (event.kind === "tool") return <Wrench size={14} />;
  if (event.status === "completed" || event.status === "applied") return <CheckCircle2 size={14} />;
  return <Activity size={14} />;
}

function hasModel(event: ActivityEvent): string {
  const model = String(event.facts?.model ?? "");
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

const GENERIC_RESULT_SUMMARIES = new Set([
  "AI 已整理本次協助結果。",
  "AI 已完成協助。",
  "AI 已完成協助，Canopy 也完成必要的收尾驗證。",
  "AI completed this turn.",
]);

function visibleSummary(value: string | undefined, locale: Locale): string {
  const summary = String(value ?? "").trim();
  return GENERIC_RESULT_SUMMARIES.has(summary)
    ? t(locale, "life.summary_unavailable")
    : summary;
}

interface LearningDisposition {
  mode: "applied" | "reviewed" | "reviewing" | "pending" | "none" | "incomplete";
  title: string;
  detail: string;
  nextBenefit: string;
  stage: string;
}

function learningDisposition(event: ActivityEvent, locale: Locale): LearningDisposition | undefined {
  // A concrete learning is rendered from Core evidence below. Never replace it
  // with a UI inference or reuse an assistant summary as if it were memory.
  if (String(event.learning ?? "").trim()) return undefined;

  const resolverStatus = String(event.facts?.resolver_status ?? "");
  const matchedCards = Number(event.facts?.matched_cards ?? 0) || 0;
  const matchedExistingMemory = matchedCards > 0 || [
    "specific_card_matched",
    "semantic_review_required",
  ].includes(resolverStatus);

  if (event.kind === "seed_action") {
    if (event.status === "applied") {
      return {
        mode: "applied",
        title: t(locale, "life.learning.applied"),
        detail: t(locale, "life.learning.applied_detail"),
        nextBenefit: event.next_benefit || t(locale, "life.learning.applied_next"),
        stage: "applied",
      };
    }
    return {
      mode: "reviewed",
      title: t(locale, "life.learning.reviewed"),
      detail: t(locale, "life.learning.reviewed_detail"),
      nextBenefit: t(locale, "life.learning.reviewed_next"),
      stage: "reviewed",
    };
  }

  if (event.growth_stage === "applied") {
    return {
      mode: "applied",
      title: t(locale, "life.learning.applied"),
      detail: t(locale, "life.learning.applied_detail"),
      nextBenefit: event.next_benefit || t(locale, "life.learning.applied_next"),
      stage: "applied",
    };
  }

  if (event.kind === "miss_analysis") {
    return {
      mode: "reviewing",
      title: t(locale, "life.learning.miss_review"),
      detail: t(locale, "life.learning.miss_review_detail"),
      nextBenefit: "",
      stage: "observed",
    };
  }

  if (event.kind === "seed_intake") {
    return {
      mode: "reviewing",
      title: t(locale, "life.learning.evidence_unavailable"),
      detail: t(locale, "life.learning.evidence_unavailable_detail"),
      nextBenefit: "",
      stage: event.growth_stage || "observed",
    };
  }

  if (event.kind !== "turn") return undefined;

  if (event.status === "in_progress") {
    return {
      mode: matchedExistingMemory ? "reviewing" : "pending",
      title: t(locale, matchedExistingMemory ? "life.learning.reviewing" : "life.learning.pending"),
      detail: t(locale, matchedExistingMemory ? "life.learning.reviewing_detail" : "life.learning.pending_detail"),
      nextBenefit: "",
      stage: "pending",
    };
  }

  if (event.phase === "protection" || ["blocked", "interrupted", "attention", "failed"].includes(event.status)) {
    return {
      mode: "incomplete",
      title: t(locale, "life.learning.incomplete"),
      detail: t(locale, "life.learning.incomplete_detail"),
      nextBenefit: "",
      stage: "incomplete",
    };
  }

  if (matchedExistingMemory) {
    return {
      mode: "reviewing",
      title: t(locale, "life.learning.matched"),
      detail: t(locale, "life.learning.matched_detail"),
      nextBenefit: "",
      stage: "observed",
    };
  }

  return {
    mode: "none",
    title: t(locale, "life.learning.none"),
    detail: t(locale, "life.learning.none_detail"),
    nextBenefit: "",
    stage: "none",
  };
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
  const [expandedEventId, setExpandedEventId] = useState("");
  const visibleEvents = useMemo(() => {
    return events.filter((event) => {
      if (filter === "growth") return Boolean(event.growth_stage || event.phase === "growth");
      if (filter === "protection") {
        return event.phase === "protection" || ["blocked", "failed", "interrupted"].includes(event.status);
      }
      return true;
    });
  }, [events, filter]);
  const current = events[0];
  const currentModel = current ? hasModel(current) : "";
  const currentSummary = current ? visibleSummary(current.summary, locale) : "";

  function selectEvent(event: ActivityEvent) {
    setExpandedEventId((currentId) => currentId === event.id ? "" : event.id);
    onSelectModule(event.module_id);
  }

  if (!open) {
    return (
      <button className="life-stream-peek" onClick={onToggle} aria-label={t(locale, "life.open")}>
        <span className="life-pulse" data-status={sync.status} />
        <HeartPulse size={17} />
        <span><strong>{t(locale, "life.title")}</strong><small>{currentSummary || t(locale, "life.no_events")}</small></span>
        <em>{stats.total}</em>
        <ChevronDown className="life-fold-direction" size={15} />
      </button>
    );
  }

  return (
    <aside className="life-stream-panel" aria-label={t(locale, "aria.life_stream")} data-sync={sync.status}>
      <header className="life-stream-heading">
        <div><HeartPulse size={18} /><span><small>{t(locale, "life.eyebrow")}</small><strong>{t(locale, "life.title")}</strong></span></div>
        <div className="life-heading-actions">
          <span className="life-sync-state" data-status={sync.status}><i />{t(locale, `life.sync.${sync.status}`)}</span>
          <button className="icon-button" onClick={onToggle} aria-label={t(locale, "life.close")}><ChevronUp size={16} /></button>
        </div>
      </header>

      <section className="life-current" data-status={current?.status ?? "starting"}>
        <div className="life-current-label"><span className="life-pulse" data-status={current?.status ?? sync.status} />{t(locale, "life.current")}</div>
        <strong>{currentSummary || t(locale, "life.waiting")}</strong>
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
        {visibleEvents.length ? visibleEvents.slice(0, 36).map((event) => {
          const expanded = expandedEventId === event.id;
          const relatedEvents = event.correlation_id
            ? events.filter((candidate) => candidate.correlation_id === event.correlation_id && candidate.id !== event.id).slice(0, 8)
            : [];
          const facts = VISIBLE_FACTS
            .map((key) => [key, event.facts?.[key]] as const)
            .filter(([, value]) => value && value !== "unreported" && value !== "0" && value !== "false");
          const summary = visibleSummary(event.summary, locale);
          const assistance = visibleSummary(event.assistance, locale);
          const learningState = learningDisposition(event, locale);
          return (
          <article key={event.id} className="life-event" data-kind={event.kind} data-phase={event.phase} data-status={event.status} data-expanded={expanded ? "true" : "false"}>
            <button className="life-event-main" onClick={() => selectEvent(event)} aria-expanded={expanded}>
              <span className="life-event-icon">{phaseIcon(event)}</span>
              <span className="life-event-copy">
                <span><time>{new Date(event.occurred_at).toLocaleString(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time><em>{t(locale, `life.phase.${event.phase}`)}</em></span>
                <strong>{activityKind(locale, event.kind)}</strong>
                <small>{summary}</small>
              </span>
              <span className="life-event-status">{activityStatus(locale, event.status)}<ChevronRight size={12} /></span>
            </button>
            {expanded && (
              <section className="life-event-details" aria-label={t(locale, "life.details")}>
                <header><strong>{t(locale, "life.details")}</strong><small>{t(locale, "life.focus_note")}</small></header>
                {assistance && <div><span>{t(locale, "life.helped")}</span><p>{assistance}</p></div>}
                {event.request_effect && <div><span>{t(locale, "life.request_effect")}</span><p>{event.request_effect}</p></div>}
                {event.verification && <div><span>{t(locale, "life.verified")}</span><p>{event.verification}</p></div>}
                {learningState && (
                  <div className="life-learning-status" data-mode={learningState.mode}>
                    <span><Sparkles size={12} />{t(locale, "life.learning_status")}</span>
                    <strong>{learningState.title}</strong>
                    <p>{learningState.detail}</p>
                    {learningState.nextBenefit && <small><strong>{t(locale, "life.next_time")}</strong>{learningState.nextBenefit}</small>}
                    <em>{t(locale, `life.stage.${learningState.stage}`)}</em>
                  </div>
                )}
                {facts.length > 0 && <dl>{facts.map(([key, value]) => <div key={key}><dt>{t(locale, `life.fact.${key}`)}</dt><dd>{value}</dd></div>)}</dl>}
                {relatedEvents.length > 0 && (
                  <div className="life-turn-steps">
                    <span>{t(locale, "life.turn_steps", { count: relatedEvents.length + 1 })}</span>
                    <ol>{[event, ...relatedEvents].sort((left, right) => left.occurred_at.localeCompare(right.occurred_at)).map((step) => (
                      <li key={step.id}><i data-status={step.status} /><span><strong>{activityKind(locale, step.kind)}</strong><small>{visibleSummary(step.assistance || step.summary, locale)}</small></span></li>
                    ))}</ol>
                  </div>
                )}
              </section>
            )}
            {event.learning && (
              <div className="life-learning">
                <span><Sparkles size={13} />{t(locale, "life.learned")}</span>
                <p>{event.learning}</p>
                {event.next_benefit && <small><strong>{t(locale, "life.next_time")}</strong>{event.next_benefit}</small>}
                <em data-stage={event.growth_stage}>{t(locale, `life.stage.${event.growth_stage || "observed"}`)}</em>
              </div>
            )}
          </article>
          );
        }) : <div className="life-empty"><RefreshCw size={18} /><p>{t(locale, filter === "all" ? "life.no_events" : "life.no_filtered_events")}</p></div>}
      </div>

      <footer className="life-stream-footer">
        <button onClick={onOpenTimeline}>{t(locale, "life.open_calendar")}<ChevronRight size={13} /></button>
        <span>{t(locale, "life.retention", { count: retentionDays, total: stats.total })}</span>
        <small>{t(locale, "life.privacy")}</small>
      </footer>
    </aside>
  );
}
