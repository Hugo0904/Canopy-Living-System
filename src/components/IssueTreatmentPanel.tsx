import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bot,
  Check,
  CheckCircle2,
  Copy,
  LoaderCircle,
  Play,
  RefreshCw,
  ShieldCheck,
  Stethoscope,
  Terminal,
  X,
} from "lucide-react";
import {
  authorizeRemediation,
  diagnoseRemediation,
  fetchRemediation,
  fetchRemediationCapabilities,
  fetchRemediationHandoff,
  openIssueRemediation,
  runRemediation,
} from "../api";
import { localizedIssueDetail, localizedIssueTitle, t, type Locale } from "../i18n";
import type {
  CanopyIssue,
  RemediationCapabilities,
  RemediationHandoff,
  RemediationMode,
  RemediationRecord,
} from "../types";

interface IssueTreatmentPanelProps {
  issue: CanopyIssue;
  locale: Locale;
  onClose: () => void;
}

const DIAGNOSABLE_STAGES = new Set(["case_open", "proposal_ready", "discussion", "revision_required"]);

function localizedState(locale: Locale, stage?: string): string {
  if (!stage) return t(locale, "remediation.stage.not_started");
  const translated = t(locale, `remediation.stage.${stage}`);
  return translated === `remediation.stage.${stage}` ? stage : translated;
}

function localizedOutcome(locale: Locale, outcome?: string): string {
  if (!outcome) return t(locale, "common.unreported");
  const translated = t(locale, `remediation.outcome.${outcome}`);
  return translated === `remediation.outcome.${outcome}` ? outcome : translated;
}

export function IssueTreatmentPanel({ issue, locale, onClose }: IssueTreatmentPanelProps) {
  const [mode, setMode] = useState<RemediationMode>(() => {
    const stored = window.localStorage.getItem("canopy.remediation.mode");
    return stored === "handoff" ? "handoff" : "embedded";
  });
  const [capabilities, setCapabilities] = useState<RemediationCapabilities | null>(null);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [record, setRecord] = useState<RemediationRecord | null>(null);
  const [handoff, setHandoff] = useState<RemediationHandoff | null>(null);
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");

  useEffect(() => {
    let active = true;
    void fetchRemediationCapabilities()
      .then((payload) => {
        if (!active) return;
        setCapabilities(payload);
        const storedModel = window.localStorage.getItem("canopy.remediation.model") || "";
        const selected = payload.models.find((item) => item.model === storedModel)
          || payload.models.find((item) => item.is_default)
          || payload.models[0];
        if (!selected) return;
        setModel(selected.model);
        const storedEffort = window.localStorage.getItem("canopy.remediation.effort") || "";
        setEffort(selected.efforts.includes(storedEffort)
          ? storedEffort
          : selected.default_effort || selected.efforts[0] || "");
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : t(locale, "remediation.error.capabilities"));
      });
    return () => { active = false; };
  }, [locale]);

  useEffect(() => {
    window.localStorage.setItem("canopy.remediation.mode", mode);
  }, [mode]);

  useEffect(() => {
    if (model) window.localStorage.setItem("canopy.remediation.model", model);
    if (effort) window.localStorage.setItem("canopy.remediation.effort", effort);
  }, [effort, model]);

  const selectedModel = useMemo(
    () => capabilities?.models.find((item) => item.model === model),
    [capabilities, model],
  );
  const evidence = issue.evidence?.length
    ? issue.evidence
    : record?.finding?.evidence || [];
  const review = record?.artifacts?.EngineeringReview;
  const canDiagnose = !record || DIAGNOSABLE_STAGES.has(record.stage);
  const canAuthorize = record?.stage === "approval_required" && Boolean(record.proposal_hash);
  const canRun = record?.stage === "experiment_ready";

  function selectModel(nextModel: string) {
    setModel(nextModel);
    const capability = capabilities?.models.find((item) => item.model === nextModel);
    if (!capability) return;
    setEffort(capability.default_effort || capability.efforts[0] || "");
  }

  async function ensureOpen(nextMode = mode): Promise<RemediationRecord> {
    if (record) return record;
    if (!issue.id) throw new Error(t(locale, "remediation.error.no_issue_id"));
    if (issue.remediation?.requestable !== true) {
      throw new Error(t(locale, "issue_detail.not_requestable"));
    }
    const opened = await openIssueRemediation({
      issue_id: issue.id,
      mode: nextMode,
      ...(model ? { model } : {}),
      ...(effort ? { reasoning_effort: effort } : {}),
    });
    setRecord(opened);
    return opened;
  }

  async function diagnose() {
    setWorking("diagnose");
    setError("");
    try {
      const opened = await ensureOpen("embedded");
      if (!DIAGNOSABLE_STAGES.has(opened.stage)) return;
      const response = await diagnoseRemediation(opened.id);
      if (response.request) setRecord(response.request);
      if (response.status !== "PASS") {
        throw new Error(response.provider?.error || t(locale, "remediation.error.diagnosis"));
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t(locale, "remediation.error.diagnosis"));
    } finally {
      setWorking("");
    }
  }

  async function authorize(decision: "operator_approved" | "operator_rejected") {
    if (!record?.proposal_hash) return;
    setWorking(decision);
    setError("");
    try {
      setRecord(await authorizeRemediation(record.id, decision, record.proposal_hash));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t(locale, "remediation.error.authorization"));
    } finally {
      setWorking("");
    }
  }

  async function execute() {
    if (!record) return;
    setWorking("run");
    setError("");
    try {
      const response = await runRemediation(record.id);
      if (response.request) setRecord(response.request);
      if (!response.request || !["PASS", "VERIFICATION_UNAVAILABLE"].includes(response.status)) {
        throw new Error(response.provider?.error || t(locale, "remediation.error.execution"));
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t(locale, "remediation.error.execution"));
    } finally {
      setWorking("");
    }
  }

  async function refresh() {
    if (!record) return;
    setWorking("refresh");
    setError("");
    try {
      setRecord(await fetchRemediation(record.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t(locale, "remediation.error.refresh"));
    } finally {
      setWorking("");
    }
  }

  async function prepareHandoff() {
    setWorking("handoff");
    setError("");
    try {
      const opened = await ensureOpen("handoff");
      setHandoff(await fetchRemediationHandoff(opened.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t(locale, "remediation.error.handoff"));
    } finally {
      setWorking("");
    }
  }

  async function copy(value: string, key: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied(""), 1600);
    } catch {
      setError(t(locale, "remediation.error.copy"));
    }
  }

  return (
    <div className="modal-backdrop remediation-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="treatment-modal remediation-modal" role="dialog" aria-modal="true" aria-labelledby="remediation-title" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <span className="eyebrow"><Stethoscope size={13} />{t(locale, "remediation.eyebrow")}</span>
            <h2 id="remediation-title">{t(locale, "remediation.title")}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label={t(locale, "common.close")}><X size={19} /></button>
        </header>

        <div className="remediation-boundary-note">
          <ShieldCheck size={17} />
          <span>{t(locale, "remediation.boundary")}</span>
        </div>

        <section className="remediation-reason">
          <span className="eyebrow">{t(locale, "remediation.reason")}</span>
          <h3>{localizedIssueTitle(locale, issue)}</h3>
          <p>{localizedIssueDetail(locale, issue)}</p>
          {evidence.length > 0 && <ul>{evidence.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}</ul>}
        </section>

        <div className="segmented-control remediation-mode" aria-label={t(locale, "remediation.mode") }>
          <button className={mode === "embedded" ? "is-active" : ""} onClick={() => { setMode("embedded"); setHandoff(null); }}>
            <Bot size={15} /><span><strong>{t(locale, "remediation.mode.embedded")}</strong><small>{t(locale, "remediation.mode.embedded_detail")}</small></span>
          </button>
          <button className={mode === "handoff" ? "is-active" : ""} onClick={() => setMode("handoff")}>
            <Terminal size={15} /><span><strong>{t(locale, "remediation.mode.handoff")}</strong><small>{t(locale, "remediation.mode.handoff_detail")}</small></span>
          </button>
        </div>

        <div className="remediation-provider-grid">
          <label>
            <span>{t(locale, "remediation.model")}</span>
            <select value={model} onChange={(event) => selectModel(event.target.value)} disabled={Boolean(record) || working !== "" || !capabilities?.available}>
              {!model && <option value="">{capabilities ? t(locale, "remediation.provider_unavailable") : t(locale, "remediation.loading_capabilities")}</option>}
              {capabilities?.models.map((item) => <option key={item.model} value={item.model}>{item.display_name || item.model}</option>)}
            </select>
          </label>
          <label>
            <span>{t(locale, "remediation.effort")}</span>
            <select value={effort} onChange={(event) => setEffort(event.target.value)} disabled={Boolean(record) || working !== "" || !selectedModel}>
              {!effort && <option value="">{t(locale, "common.unspecified")}</option>}
              {selectedModel?.efforts.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
        </div>

        {record && <section className="remediation-state" aria-live="polite">
          <div><span>{t(locale, "remediation.state")}</span><strong>{localizedState(locale, record.stage)}</strong><code>{record.id}</code></div>
          <button className="icon-button" onClick={() => void refresh()} disabled={working !== ""} aria-label={t(locale, "remediation.refresh")}><RefreshCw size={15} className={working === "refresh" ? "spin" : ""} /></button>
        </section>}

        {record?.diagnosis?.summary && <section className="remediation-report">
          <h3>{t(locale, "remediation.diagnosis")}</h3>
          <dl>
            <div><dt>{t(locale, "remediation.summary")}</dt><dd>{record.diagnosis.summary}</dd></div>
            <div><dt>{t(locale, "remediation.root_cause")}</dt><dd>{record.diagnosis.root_cause}</dd></div>
            <div><dt>{t(locale, "remediation.recommended_action")}</dt><dd>{record.diagnosis.recommended_action}</dd></div>
            {record.diagnosis.verification_plan && <div><dt>{t(locale, "remediation.verification_plan")}</dt><dd><ul>{record.diagnosis.verification_plan.map((item) => <li key={item}>{item}</li>)}</ul></dd></div>}
          </dl>
        </section>}

        {review && <section className="remediation-report remediation-review">
          <h3>{t(locale, "remediation.engineering_review")}</h3>
          <p><strong>{t(locale, "remediation.verdict")}: {String(review.verdict || t(locale, "common.unreported"))}</strong></p>
          {review.rationale && <p>{String(review.rationale)}</p>}
          {review.risks && review.risks.length > 0 && <ul>{review.risks.map((item) => <li key={item}>{item}</li>)}</ul>}
        </section>}

        {record?.verification?.outcome && <section className="remediation-verification" data-outcome={record.verification.outcome}>
          {record.verification.outcome === "resolved" ? <CheckCircle2 size={20} /> : <AlertTriangle size={20} />}
          <div><strong>{localizedOutcome(locale, record.verification.outcome)}</strong><p>{record.verification.summary}</p></div>
        </section>}

        {(record?.applied_model || record?.execution?.model) && <section className="remediation-execution-evidence">
          <span>{t(locale, "remediation.execution_evidence")}</span>
          <code>{record.applied_model || record.execution?.model} · {record.applied_reasoning_effort || record.execution?.effort || t(locale, "common.unreported")}</code>
        </section>}

        {mode === "embedded" ? <div className="remediation-actions">
          {canDiagnose && <button className="primary-command" onClick={() => void diagnose()} disabled={working !== "" || capabilities?.available === false}>
            {working === "diagnose" ? <LoaderCircle className="spin" size={18} /> : <Bot size={18} />}
            {t(locale, working === "diagnose" ? "remediation.diagnosing" : "remediation.start_diagnosis")}
          </button>}
          {canAuthorize && <>
            <p className="remediation-approval-note">{t(locale, "remediation.approval_note")}</p>
            <button className="primary-command" onClick={() => void authorize("operator_approved")} disabled={working !== ""}><Check size={18} />{t(locale, "remediation.approve")}</button>
            <button className="secondary-command" onClick={() => void authorize("operator_rejected")} disabled={working !== ""}>{t(locale, "remediation.reject")}</button>
          </>}
          {canRun && <button className="primary-command" onClick={() => void execute()} disabled={working !== ""}>
            {working === "run" ? <LoaderCircle className="spin" size={18} /> : <Play size={18} />}
            {t(locale, working === "run" ? "remediation.running" : "remediation.run")}
          </button>}
        </div> : <div className="remediation-actions">
          {!handoff && <button className="primary-command" onClick={() => void prepareHandoff()} disabled={working !== ""}>
            {working === "handoff" ? <LoaderCircle className="spin" size={18} /> : <Terminal size={18} />}
            {t(locale, working === "handoff" ? "remediation.preparing_handoff" : "remediation.prepare_handoff")}
          </button>}
          {handoff && <section className="remediation-handoff">
            <h3>{t(locale, "remediation.handoff_title")}</h3>
            <label><span>{t(locale, "remediation.cli")}</span><code>{handoff.cli.continue}</code><button onClick={() => void copy(handoff.cli.continue, "cli")}>{copied === "cli" ? <Check size={15} /> : <Copy size={15} />}{t(locale, copied === "cli" ? "remediation.copied" : "remediation.copy")}</button></label>
            <label><span>{t(locale, "remediation.desktop")}</span><p>{handoff.desktop_prompt}</p><button onClick={() => void copy(handoff.desktop_prompt, "desktop")}>{copied === "desktop" ? <Check size={15} /> : <Copy size={15} />}{t(locale, copied === "desktop" ? "remediation.copied" : "remediation.copy")}</button></label>
          </section>}
        </div>}

        {error && <p className="form-error remediation-error"><AlertTriangle size={15} />{error}</p>}
      </section>
    </div>
  );
}
