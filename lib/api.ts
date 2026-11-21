/**
 * Thin client for the coordinator REST API (backend/coordinator/main.py).
 * The browser talks to the coordinator directly; no secrets live here.
 */
import type {
  AgentsResponse,
  ExecutionCreated,
  ExecutionSnapshot,
  TripRequest,
} from "./types";

export const COORDINATOR_URL = (process.env.NEXT_PUBLIC_COORDINATOR_URL || "http://localhost:8000").replace(/\/+$/, "");

export interface HealthResponse {
  status: string;
  service: string;
  model: string;
  gemini_configured: boolean;
}

export type ApiErrorKind = "network" | "validation" | "unavailable" | "unauthorized" | "not_found" | "server";

export class ApiError extends Error {
  readonly status: number;
  readonly kind: ApiErrorKind;

  constructor(message: string, status: number, kind: ApiErrorKind) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.kind = kind;
  }
}

interface ValidationDetail {
  loc?: (string | number)[];
  msg?: string;
}

/** Turn FastAPI error bodies (`{detail: string | ValidationDetail[]}`) into one readable line. */
export function normalizeErrorDetail(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object" || !("detail" in body)) return fallback;
  const detail = (body as { detail: unknown }).detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const parts = (detail as ValidationDetail[]).map((d) => {
      const field = (d.loc ?? []).filter((p) => p !== "body").join(".");
      const msg = (d.msg ?? "invalid value").replace(/^Value error, /, "");
      return field ? `${field}: ${msg}` : msg;
    });
    return parts.join("; ") || fallback;
  }
  return fallback;
}

function kindForStatus(status: number): ApiErrorKind {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not_found";
  if (status === 422 || status === 400) return "validation";
  if (status === 503) return "unavailable";
  return "server";
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${COORDINATOR_URL}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      cache: "no-store",
    });
  } catch {
    throw new ApiError(
      `Cannot reach the coordinator at ${COORDINATOR_URL}. Is the backend running?`,
      0,
      "network",
    );
  }
  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    throw new ApiError(normalizeErrorDetail(body, `Request failed (${res.status})`), res.status, kindForStatus(res.status));
  }
  return body as T;
}

const tokenQuery = (token: string) => `token=${encodeURIComponent(token)}`;

export const api = {
  health: () => request<HealthResponse>("/health"),
  agents: () => request<AgentsResponse>("/api/agents"),
  createPlan: (trip: TripRequest) =>
    request<ExecutionCreated>("/api/plans", { method: "POST", body: JSON.stringify(trip) }),
  refinePlan: (executionId: string, token: string, instruction: string) =>
    request<ExecutionCreated>(`/api/executions/${encodeURIComponent(executionId)}/refine?${tokenQuery(token)}`, {
      method: "POST",
      body: JSON.stringify({ instruction }),
    }),
  snapshot: (executionId: string, token: string) =>
    request<ExecutionSnapshot>(`/api/executions/${encodeURIComponent(executionId)}?${tokenQuery(token)}`),
};

export function eventsUrl(executionId: string, token: string, lastEventId: number): string {
  const params = new URLSearchParams({ token });
  if (lastEventId > 0) params.set("last_event_id", String(lastEventId));
  return `${COORDINATOR_URL}/api/executions/${encodeURIComponent(executionId)}/events?${params.toString()}`;
}
