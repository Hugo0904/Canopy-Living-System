import { useEffect, useMemo, useState } from "react";
import { Beaker, FlaskConical, GitBranch, Microscope, ShieldCheck } from "lucide-react";
import { fetchEvolutionLab } from "../api";
import { t, type Locale } from "../i18n";
import type { EvolutionLabResponse, EvolutionLabWorkflowStep } from "../types";

const WORKFLOW_IDS = ["case", "proposal", "review", "experiment", "adoption", "monitoring"] as const;
const SUMMARY_IDS = ["unchanged", "regressed", "new", "active", "stored", "reportable"] as const;

function workflowPublicState(step?: EvolutionLabWorkflowStep): string {
  // A monitor candidate can carry an internal `case_open` value without a
  // persisted EvolutionCase. Prefer the public artifact status so the UI does
  // not accidentally promote candidate evidence into a completed stage.
  return step?.status === "candidate_reached"
    ? step.status
    : step?.state || step?.status || step?.reached_state || "unavailable";
}

function workflowState(locale: Locale, step?: EvolutionLabWorkflowStep): string {
  const state = workflowPublicState(step);
  if (!state) return t(locale, "lab.evidence_unavailable_short");
  if (state === "not_reached") return t(locale, "lab.state.unreported");
  const key = `lab.state.${state}`;
  const translated = t(locale, key);
  return translated === key ? state.replaceAll("_", " ") : translated;
}

function TruncationNotice({
  locale,
  truncated,
  shown,
  total,
  omitted,
}: {
  locale: Locale;
  truncated?: boolean;
  shown: number;
  total?: number;
  omitted?: number;
}) {
  if (!truncated) return null;
  const trustedOmitted = typeof omitted === "number" && omitted > 0
    ? omitted
    : typeof total === "number" && total > shown
      ? total - shown
      : undefined;
  return (
    <p className="lab-truncation" role="note">
      {trustedOmitted === undefined
        ? t(locale, "lab.truncated_unknown", { shown, omitted: 1 })
        : t(locale, "lab.truncated_known", { shown, total: total ?? shown + trustedOmitted, omitted: trustedOmitted })}
    </p>
  );
}

function summaryValue(value: unknown, locale: Locale): string {
  if (value === null || value === undefined || value === "") return t(locale, "common.unreported");
  if (typeof value === "boolean") return value ? t(locale, "lab.yes") : t(locale, "lab.no");
  if (typeof value === "number") return value.toLocaleString(locale);
  if (typeof value === "string") {
    const key = `lab.value.${value}`;
    const translated = t(locale, key);
    if (translated !== key) return translated;
  }
  return String(value);
}

function summaryLabel(key: string, locale: Locale): string {
  const messageKey = `lab.summary.${key}`;
  const translated = t(locale, messageKey);
  return translated === messageKey ? key.replaceAll("_", " ") : translated;
}

function findingValue(value: string | undefined, locale: Locale): string {
  if (!value) return t(locale, "common.unreported");
  const messageKey = `lab.finding_value.${value}`;
  const translated = t(locale, messageKey);
  return translated === messageKey ? value.replaceAll("_", " ") : translated;
}

function findingNarrative(
  locale: Locale,
  category: string | undefined,
  kind: "summary" | "suggestion",
  fallback: string | undefined,
): string {
  const messageKey = `lab.finding_${kind}.${category || "unavailable"}`;
  const translated = t(locale, messageKey);
  return translated === messageKey ? fallback || t(locale, "common.no_summary") : translated;
}

export function EvolutionLab({ locale, showHeader = true }: { locale: Locale; showHeader?: boolean }) {
  const [lab, setLab] = useState<EvolutionLabResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setUnavailable(false);
    void fetchEvolutionLab()
      .then((payload) => {
        if (cancelled) return;
        setLab(payload);
        setUnavailable(payload.status === "unavailable");
      })
      .catch(() => {
        if (cancelled) return;
        setLab(null);
        setUnavailable(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const steps = useMemo(() => {
    const byId = new Map((lab?.workflow ?? lab?.workflow_stages ?? []).map((step) => [step.id, step]));
    return WORKFLOW_IDS.map((id) => ({ id, step: byId.get(id) }));
  }, [lab?.workflow, lab?.workflow_stages]);
  const researchSummary = lab?.summary ?? lab?.monitor?.summary ?? {};
  const findings = lab?.findings ?? [];
  const caseCandidates = lab?.case_candidates ?? [];
  const visibleFindings = findings.slice(0, 5);
  const visibleCaseCandidates = caseCandidates.slice(0, 5);
  const findingsTruncated = Boolean(lab?.findings_truncated || findings.length > visibleFindings.length);
  const caseCandidatesTruncated = Boolean(lab?.case_candidates_truncated || caseCandidates.length > visibleCaseCandidates.length);
  const findingsTotal = lab?.findings_total ?? lab?.totals?.findings ?? (findings.length > visibleFindings.length ? findings.length : undefined);
  const caseCandidatesTotal = lab?.case_candidates_total ?? lab?.totals?.case_candidates ?? (caseCandidates.length > visibleCaseCandidates.length ? caseCandidates.length : undefined);

  return (
    <section className="evolution-lab" aria-label={t(locale, "lab.title")} data-status={unavailable ? "unavailable" : lab?.status ?? "loading"}>
      {showHeader && <header>
        <span><FlaskConical size={17} /></span>
        <div><small>{t(locale, "lab.eyebrow")}</small><h3>{t(locale, "lab.title")}</h3></div>
      </header>}
      <p className="lab-boundary"><ShieldCheck size={14} />{t(locale, "lab.boundary")}</p>
      <p className="lab-runtime-link"><GitBranch size={14} />{t(locale, "lab.runtime_link")}</p>

      {loading ? (
        <p className="lab-unavailable"><Microscope size={17} />{t(locale, "lab.loading")}</p>
      ) : unavailable ? (
        <p className="lab-unavailable"><Microscope size={17} />{t(locale, "lab.evidence_unavailable")}</p>
      ) : (
        <>
          {lab?.status === "degraded" && <p className="lab-partial">{t(locale, "lab.partial_evidence")}</p>}
          <div className="lab-contract">
            <div><span>{t(locale, "lab.contract_status")}</span><strong>{summaryValue(lab?.contract?.status ?? lab?.contract?.health, locale)}</strong></div>
            <div><span>{t(locale, "lab.contract_version")}</span><strong>{summaryValue(lab?.contract?.version, locale)}</strong></div>
            <div><span>{t(locale, "lab.routing_cases")}</span><strong>{summaryValue(lab?.contract?.routing_cases, locale)}</strong></div>
            <div><span>{t(locale, "lab.runtime_budget")}</span><strong>{summaryValue(lab?.contract?.runtime_chars, locale)} / {summaryValue(lab?.contract?.runtime_target_chars, locale)}</strong></div>
          </div>

          {Object.keys(researchSummary).length > 0 && (
            <section className="lab-summary">
              <h4>{t(locale, "lab.summary")}</h4>
              <dl>
                {SUMMARY_IDS.filter((key) => key in researchSummary).map((key) => (
                  <div key={key}><dt>{summaryLabel(key, locale)}</dt><dd>{summaryValue(researchSummary[key], locale)}</dd></div>
                ))}
              </dl>
            </section>
          )}

          <section className="lab-workflow" aria-label={t(locale, "lab.workflow") }>
            <h4>{t(locale, "lab.workflow")}</h4>
            <ol>
              {steps.map(({ id, step }) => (
                <li key={id} data-state={workflowPublicState(step)}>
                  <span className="lab-step-marker" />
                  <div>
                    <strong>{t(locale, `lab.step.${id}`)}</strong>
                    <small>{workflowState(locale, step)}</small>
                    {(step?.evidence_status || step?.basis) && <em>{t(locale, "lab.evidence")}: {summaryValue(step.evidence_status ?? step.basis, locale)}</em>}
                  </div>
                </li>
              ))}
            </ol>
          </section>

          {(visibleCaseCandidates.length > 0 || caseCandidatesTruncated) && (
            <section className="lab-cases">
              <h4>{t(locale, "lab.case_candidates")}</h4>
              {visibleCaseCandidates.map((candidate, index) => (
                <article key={candidate.case_id || `case-candidate-${index}`}>
                  <header>
                    <span>{candidate.case_id || t(locale, "common.unreported")}</span>
                    <em>{t(locale, "lab.candidate_only")}</em>
                  </header>
                  <strong>{t(locale, "lab.candidate_problem")}</strong>
                  <p><b>{t(locale, "lab.target_outcome")}</b>{t(locale, "lab.candidate_target")}</p>
                  <dl>
                    <div><dt>{t(locale, "lab.candidate_status")}</dt><dd>{summaryValue(candidate.artifact_status || "candidate_only", locale)}</dd></div>
                    <div><dt>{t(locale, "lab.persistence")}</dt><dd>{summaryValue(candidate.artifact_persistence ?? (candidate.artifact_persisted === true ? "persisted" : "not_reported"), locale)}</dd></div>
                    {candidate.scope && candidate.scope !== "unreported" && <div><dt>{t(locale, "card.scope")}</dt><dd>{candidate.scope}</dd></div>}
                  </dl>
                  {candidate.evidence?.length ? (
                    <details>
                      <summary>{t(locale, "lab.finding_evidence")} · {candidate.evidence.length}</summary>
                      <ul>{candidate.evidence.slice(0, 4).map((item, evidenceIndex) => <li key={`${candidate.case_id}-evidence-${evidenceIndex}`}>{item}</li>)}</ul>
                    </details>
                  ) : null}
                </article>
              ))}
              {!visibleCaseCandidates.length && <p className="lab-empty"><Beaker size={16} />{t(locale, "lab.no_case_candidates")}</p>}
              <TruncationNotice
                locale={locale}
                truncated={caseCandidatesTruncated}
                shown={visibleCaseCandidates.length}
                total={caseCandidatesTotal}
                omitted={lab?.case_candidates_omitted}
              />
            </section>
          )}

          <section className="lab-findings">
            <h4>{t(locale, "lab.findings")}</h4>
            {visibleFindings.length ? visibleFindings.map((finding) => (
              <article key={finding.id}>
                <header><span>{finding.category ? findingValue(finding.category, locale) : t(locale, "lab.finding")}</span><em>{findingValue(finding.status, locale)}</em></header>
                <strong>{findingNarrative(locale, finding.category, "summary", finding.summary)}</strong>
                <p>{findingNarrative(locale, finding.category, "suggestion", finding.suggested_improvement)}</p>
                <dl>
                  {finding.priority && <div><dt>{t(locale, "lab.priority")}</dt><dd>{findingValue(finding.priority, locale)}</dd></div>}
                  {finding.owner && <div><dt>{t(locale, "lab.owner")}</dt><dd>{findingValue(finding.owner, locale)}</dd></div>}
                  {(finding.case?.case_id || finding.case_id) && <div><dt>{t(locale, "lab.case_id")}</dt><dd>{finding.case?.case_id || finding.case_id}</dd></div>}
                  {finding.case?.current_state && <div><dt>{t(locale, "lab.current_state")}</dt><dd>{findingValue(finding.case.current_state, locale)}</dd></div>}
                  {finding.case?.target_outcome && <div><dt>{t(locale, "lab.target_outcome")}</dt><dd>{finding.case.target_outcome}</dd></div>}
                </dl>
                {finding.evidence?.length ? (
                  <details>
                    <summary>{t(locale, "lab.finding_evidence")} · {finding.evidence.length}</summary>
                    <ul>{finding.evidence.slice(0, 4).map((item, index) => <li key={`${finding.id}-evidence-${index}`}>{item}</li>)}</ul>
                  </details>
                ) : null}
              </article>
            )) : <p className="lab-empty"><Beaker size={16} />{t(locale, "lab.no_findings")}</p>}
            <TruncationNotice
              locale={locale}
              truncated={findingsTruncated}
              shown={visibleFindings.length}
              total={findingsTotal}
              omitted={lab?.findings_omitted}
            />
          </section>
          {lab?.generated_at && <time className="lab-generated" dateTime={lab.generated_at}>{t(locale, "lab.generated_at")}: {new Date(lab.generated_at).toLocaleString(locale)}</time>}
        </>
      )}
    </section>
  );
}
