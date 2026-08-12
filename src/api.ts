import type { CanopySnapshot, EvolutionLabResponse, LifeEventsResponse, SyncSnapshotResponse, TreatmentRequest } from "./types";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { detail?: string };
    throw new Error(payload.detail || `${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

export function fetchSnapshot(refresh = false): Promise<CanopySnapshot> {
  return request(`/api/snapshot${refresh ? "?refresh=true" : ""}`);
}

export function syncSnapshot(): Promise<SyncSnapshotResponse> {
  return request("/api/sync", { method: "POST" });
}

export function fetchLifeEvents(refresh = false, limit = 220): Promise<LifeEventsResponse> {
  const parameters = new URLSearchParams({
    limit: String(limit),
    refresh: refresh ? "true" : "false",
  });
  return request(`/api/life-events?${parameters.toString()}`);
}

export function fetchEvolutionLab(): Promise<EvolutionLabResponse> {
  return request("/api/evolution-lab");
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
