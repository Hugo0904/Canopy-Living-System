import { useMemo, useState } from "react";
import { Bot, Check, CheckCircle2, Copy, Send, ShieldCheck, X } from "lucide-react";
import { createTreatment } from "../api";
import { t, type Locale } from "../i18n";
import type { TreatmentRequest, TreatmentTarget } from "../types";

interface TreatmentComposerProps {
  target: TreatmentTarget;
  locale: Locale;
  intents: Array<"create" | "update" | "merge" | "archive" | "diagnose">;
  initialIntent?: "create" | "update" | "merge" | "archive" | "diagnose";
  onClose: () => void;
}

export function TreatmentComposer({ target, locale, intents, initialIntent, onClose }: TreatmentComposerProps) {
  const [intent, setIntent] = useState(initialIntent && intents.includes(initialIntent) ? initialIntent : intents[0]);
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<TreatmentRequest | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const handoffText = useMemo(() => result ? [
    `請審查 Canopy 生命體系統調整請求 ${result.id}。`,
    `先從 ${window.location.origin}/api/treatments/${result.id} 讀取結構化內容。`,
    "請依 Canopy 演化規範分析、提出差異與測試，不要在操作者確認前直接套用。",
  ].join("\n") : "", [result]);

  async function submit() {
    setSubmitting(true);
    setError("");
    try {
      const created = await createTreatment({
        target_type: target.type,
        target_id: target.id,
        intent,
        operator_prompt: prompt,
      });
      setResult(created);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t(locale, "treatment.error"));
    } finally {
      setSubmitting(false);
    }
  }

  async function copyHandoff() {
    await navigator.clipboard.writeText(handoffText);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="treatment-modal" role="dialog" aria-modal="true" aria-labelledby="treatment-title" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <span className="eyebrow">{t(locale, "treatment.eyebrow")}</span>
            <h2 id="treatment-title">{t(locale, target.type === "module" ? "treatment.module_title" : target.id === "new-seed-card" ? "treatment.create_title" : "treatment.title")}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label={t(locale, "treatment.close")}><X size={19} /></button>
        </header>

        {!result ? (
          <>
            <div className="proposal-target">
              <ShieldCheck size={18} />
              <div><strong>{target.title}</strong><code>{target.id}</code><span>{t(locale, "treatment.no_direct_edit")}</span></div>
            </div>
            <label className="field-label" htmlFor="intent">{t(locale, "treatment.intent")}</label>
            <div className="segmented-control" id="intent" style={{ gridTemplateColumns: `repeat(${intents.length}, 1fr)` }}>
              {intents.map((value) => (
                <button key={value} className={intent === value ? "is-active" : ""} onClick={() => setIntent(value)}>{t(locale, `treatment.intent.${value}`)}</button>
              ))}
            </div>
            <label className="field-label" htmlFor="treatment-prompt">{t(locale, "treatment.prompt")}</label>
            <textarea
              id="treatment-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder={t(locale, target.type === "module" ? "treatment.module_placeholder" : target.id === "new-seed-card" ? "treatment.create_placeholder" : "treatment.placeholder")}
              rows={6}
            />
            <div className="guard-note"><Bot size={17} /><span>{t(locale, "treatment.guard")}</span></div>
            {error && <p className="form-error">{error}</p>}
            <button className="primary-command" onClick={submit} disabled={submitting || prompt.trim().length < 4}>
              <Send size={18} /> {t(locale, submitting ? "treatment.submitting" : "treatment.submit")}
            </button>
          </>
        ) : (
          <div className="proposal-created">
            <CheckCircle2 size={38} />
            <h3>{t(locale, "treatment.created")}</h3>
            <code>{result.id}</code>
            <p>{t(locale, "treatment.created_detail")}</p>
            <button className="primary-command" onClick={() => void copyHandoff()}>
              {copied ? <Check size={18} /> : <Copy size={18} />}{t(locale, copied ? "treatment.copied" : "treatment.copy_codex")}
            </button>
            <button className="secondary-command" onClick={onClose}>{t(locale, "treatment.done")}</button>
          </div>
        )}
      </section>
    </div>
  );
}
