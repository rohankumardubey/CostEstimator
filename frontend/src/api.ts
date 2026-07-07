import type {
  EstimateRequest,
  EstimateResponse,
  PricingConfig,
  SavedEstimateCreate,
  SavedEstimateDetail,
  SavedEstimateListResponse,
  ScenarioComparisonResponse,
  ScenarioConfig
} from "./types";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "/api";

async function requestJson<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: options?.body instanceof FormData ? undefined : { "Content-Type": "application/json" },
    ...options
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(error || `Request failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function getPricingConfig(): Promise<PricingConfig> {
  return requestJson<PricingConfig>("/pricing-config");
}

export function getScenarios(): Promise<Record<string, ScenarioConfig>> {
  return requestJson<Record<string, ScenarioConfig>>("/scenarios");
}

export function postEstimate(payload: EstimateRequest): Promise<EstimateResponse> {
  return requestJson<EstimateResponse>("/estimate", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function postScenarioComparison(payload: EstimateRequest): Promise<ScenarioComparisonResponse> {
  return requestJson<ScenarioComparisonResponse>("/scenario-comparison", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function getSavedEstimates(): Promise<SavedEstimateListResponse> {
  return requestJson<SavedEstimateListResponse>("/estimates");
}

export function getSavedEstimate(estimateId: string): Promise<SavedEstimateDetail> {
  return requestJson<SavedEstimateDetail>(`/estimates/${encodeURIComponent(estimateId)}`);
}

export function postSavedEstimate(payload: SavedEstimateCreate): Promise<SavedEstimateDetail> {
  return requestJson<SavedEstimateDetail>("/estimates", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function exportBlob(path: "/export/json" | "/export/csv" | "/export/pdf", payload: unknown): Promise<Blob> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.blob();
}
