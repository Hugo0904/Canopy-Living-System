import type {
  EvolutionLabResponse,
  FuraGuidanceAnswerResponse,
  FuraGuidanceDecisionResponse,
  FuraGuidanceResponse,
  LifeEventsResponse,
  LifeEventsRevisionResponse,
  RemediationCapabilities,
  RemediationHandoff,
  RemediationMode,
  RemediationRecord,
  RemediationResponse,
  SnapshotRevisionResponse,
  SyncSnapshotResponse,
  TreatmentRequest,
} from "./types";
import type { Locale } from "./i18n";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      detail?: string | { message?: string; code?: string };
    };
    const detail = typeof payload.detail === "string"
      ? payload.detail
      : payload.detail?.message;
    throw new Error(detail || `${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

export function fetchSnapshot(refresh = false): Promise<SyncSnapshotResponse> {
  return refresh ? syncSnapshot() : request("/api/snapshot");
}

export function fetchSnapshotRevision(signal?: AbortSignal): Promise<SnapshotRevisionResponse> {
  return request("/api/snapshot/revision", { signal });
}

export function syncSnapshot(): Promise<SyncSnapshotResponse> {
  return request("/api/sync", { method: "POST" });
}

export function fetchLifeEvents(limit = 140, signal?: AbortSignal): Promise<LifeEventsResponse> {
  const parameters = new URLSearchParams({
    limit: String(limit),
  });
  return request(`/api/life-events?${parameters.toString()}`, { signal });
}

export function fetchLifeEventRevision(signal?: AbortSignal): Promise<LifeEventsRevisionResponse> {
  return request("/api/life-events/revision", { signal });
}

export function fetchEvolutionLab(): Promise<EvolutionLabResponse> {
  return request("/api/evolution-lab");
}

export function fetchFuraGuidance(locale: Locale = "zh-TW", signal?: AbortSignal): Promise<FuraGuidanceResponse> {
  const parameters = new URLSearchParams({ locale });
  return request(`/api/guidance/current?${parameters.toString()}`, { signal });
}

export function decideFuraGuidance(
  guidanceId: string,
  input: {
    decision: "snooze" | "dismiss";
    expected_fingerprint: string;
    snooze_hours?: number;
  },
): Promise<FuraGuidanceDecisionResponse> {
  return request(`/api/guidance/${encodeURIComponent(guidanceId)}/decision`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function answerFuraGuidance(
  guidanceId: string,
  input: { answer: string; expected_fingerprint: string },
): Promise<FuraGuidanceAnswerResponse> {
  return request(`/api/guidance/${encodeURIComponent(guidanceId)}/answer`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function fetchRemediationCapabilities(): Promise<RemediationCapabilities> {
  return request("/api/remediations/capabilities");
}

export function openIssueRemediation(input: {
  issue_id: string;
  mode: RemediationMode;
  model?: string;
  reasoning_effort?: string;
}): Promise<RemediationRecord> {
  return request("/api/remediations", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function fetchRemediation(remediationId: string): Promise<RemediationRecord> {
  return request(`/api/remediations/${encodeURIComponent(remediationId)}`);
}

export function diagnoseRemediation(remediationId: string): Promise<RemediationResponse> {
  return request(`/api/remediations/${encodeURIComponent(remediationId)}/diagnose`, {
    method: "POST",
  });
}

export function authorizeRemediation(
  remediationId: string,
  decision: "operator_approved" | "operator_rejected",
  proposalHash: string,
): Promise<RemediationRecord> {
  return request(`/api/remediations/${encodeURIComponent(remediationId)}/authorize`, {
    method: "POST",
    body: JSON.stringify({ decision, proposal_hash: proposalHash }),
  });
}

export function runRemediation(remediationId: string): Promise<RemediationResponse> {
  return request(`/api/remediations/${encodeURIComponent(remediationId)}/run`, {
    method: "POST",
  });
}

export function fetchRemediationHandoff(remediationId: string): Promise<RemediationHandoff> {
  return request(`/api/remediations/${encodeURIComponent(remediationId)}/handoff`);
}

export function createTreatment(input: {
  target_type: string;
  target_id: string;
  intent: string;
  operator_prompt: string;
}): Promise<TreatmentRequest> {
  return request("/api/treatments", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
