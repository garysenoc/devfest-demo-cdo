/**
 * Pure derivation of per-agent view state from real backend events.
 *
 * Nothing here invents activity: every field is computed from ExecutionEvents
 * (emitted by the coordinator while it performs real A2A calls) or from the
 * live Agent Card check in /api/agents.
 */
import { toMs } from "./format";
import type { AgentId, AgentInfo, AgentStatus, ExecutionEvent } from "./types";
import { AGENT_IDS } from "./types";

export interface AgentMeta {
  name: string;
  short: string;
  role: string;
  description: string;
}

/** Static fallbacks used before /api/agents responds. */
export const AGENT_META: Record<AgentId, AgentMeta> = {
  coordinator: {
    name: "Travel Coordinator",
    short: "Coordinator",
    role: "Orchestration and delegation",
    description: "Discovers specialists via Agent Cards, delegates A2A tasks and consolidates the plan.",
  },
  destination: {
    name: "Destination Research Agent",
    short: "Destination",
    role: "Destination discovery",
    description: "Recommends attractions, activities and local food matched to traveler interests.",
  },
  budget: {
    name: "Budget Planning Agent",
    short: "Budget",
    role: "Expense estimation",
    description: "Estimates transport, lodging, food and activity costs with contingency.",
  },
  itinerary: {
    name: "Itinerary Planning Agent",
    short: "Itinerary",
    role: "Daily scheduling",
    description: "Builds a realistic day-by-day schedule from research and budget results.",
  },
};

export interface AgentView {
  id: AgentId;
  name: string;
  description: string;
  role: string;
  url: string | null;
  availability: "available" | "offline" | "unknown";
  status: AgentStatus;
  currentTask: string | null;
  taskId: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  latestActivity: string | null;
  latestActivityAt: string | null;
  outputSummary: string | null;
  attempts: number;
  events: ExecutionEvent[];
  info: AgentInfo | null;
}

const TERMINAL: AgentStatus[] = ["completed", "failed"];

function baseView(id: AgentId, info: AgentInfo | undefined): AgentView {
  const meta = AGENT_META[id];
  const availability = info ? info.status : "unknown";
  return {
    id,
    name: info?.name || meta.name,
    description: info?.description || meta.description,
    role: info?.role || meta.role,
    url: info?.url ?? null,
    availability,
    status: availability === "available" ? "available" : "offline",
    currentTask: null,
    taskId: null,
    startedAt: null,
    finishedAt: null,
    latestActivity: null,
    latestActivityAt: null,
    outputSummary: null,
    attempts: 0,
    events: [],
    info: info ?? null,
  };
}

export function sortEvents(events: ExecutionEvent[]): ExecutionEvent[] {
  return [...events].sort((a, b) => a.seq - b.seq);
}

function metaString(event: ExecutionEvent, key: string): string | null {
  const value = event.metadata?.[key];
  return typeof value === "string" && value ? value : null;
}

function metaNumber(event: ExecutionEvent, key: string): number | null {
  const value = event.metadata?.[key];
  return typeof value === "number" ? value : null;
}

export function deriveAgentViews(
  events: ExecutionEvent[],
  agents: AgentInfo[] = [],
): Record<AgentId, AgentView> {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const views = Object.fromEntries(AGENT_IDS.map((id) => [id, baseView(id, byId.get(id))])) as Record<
    AgentId,
    AgentView
  >;

  for (const event of sortEvents(events)) {
    const ts = toMs(event.timestamp);
    const sender = views[event.agent_id];
    const target = event.target_agent_id ? views[event.target_agent_id] : null;

    sender.events.push(event);
    if (target && target !== sender) target.events.push(event);

    sender.latestActivity = event.message;
    sender.latestActivityAt = event.timestamp;

    // The output summary rides on whichever event carries metadata.summary
    // (the coordinator attaches it to the "completed" agent_status event).
    const summary = metaString(event, "summary");
    if (summary) sender.outputSummary = summary;
    const attempt = metaNumber(event, "attempt");
    if (attempt !== null && event.agent_id !== "coordinator") sender.attempts = Math.max(sender.attempts, attempt);

    if (event.status) {
      sender.status = event.status;
      if (TERMINAL.includes(event.status)) sender.finishedAt = ts;
      if (event.status === "retrying") sender.finishedAt = null;
    }

    if (event.type === "discovery_response") {
      sender.availability = event.metadata?.error === true ? "offline" : "available";
    }

    // Specialist task id: requests carry the target's task, responses the sender's.
    if (event.task_id) {
      if (event.agent_id !== "coordinator") sender.taskId = event.task_id;
      else if (target && target.id !== "coordinator") target.taskId = event.task_id;
    }

    switch (event.type) {
      case "execution_started":
        sender.startedAt = ts;
        sender.finishedAt = null;
        sender.currentTask = "Orchestrating the travel plan";
        break;
      case "execution_completed":
      case "execution_failed":
        sender.finishedAt = ts;
        break;
      case "a2a_request":
        if (target) {
          target.currentTask = metaString(event, "task_label") ?? event.message;
          target.latestActivity = event.message;
          target.latestActivityAt = event.timestamp;
          if (target.startedAt === null) target.startedAt = ts;
          target.finishedAt = null;
          target.attempts = metaNumber(event, "attempt") ?? target.attempts + 1;
          target.taskId = event.task_id ?? null;
        }
        break;
      case "a2a_artifact":
        if (!summary && !sender.outputSummary) sender.outputSummary = event.message;
        break;
      case "plan_ready":
        if (!summary) sender.outputSummary = event.message;
        break;
      case "orchestration":
        if (event.agent_id === "coordinator") sender.currentTask = event.message;
        break;
      default:
        break;
    }
  }
  return views;
}

export function agentDuration(view: AgentView, now: number): number | null {
  if (view.startedAt === null) return null;
  return (view.finishedAt ?? now) - view.startedAt;
}

export function isActive(status: AgentStatus): boolean {
  return status === "pending" || status === "running" || status === "communicating" || status === "retrying" || status === "discovering";
}

// ---------------------------------------------------------------------------
// Graph edges
// ---------------------------------------------------------------------------
export type SpecialistId = Exclude<AgentId, "coordinator">;
export type EdgeState = "idle" | "active" | "completed" | "failed";

export interface EdgeView {
  id: SpecialistId;
  state: EdgeState;
  requests: number;
  responses: number;
}

export function deriveEdges(views: Record<AgentId, AgentView>): Record<SpecialistId, EdgeView> {
  const result = {} as Record<SpecialistId, EdgeView>;
  for (const id of ["destination", "budget", "itinerary"] as SpecialistId[]) {
    const v = views[id];
    const a2a = v.events.filter((e) => e.channel === "a2a");
    const requests = a2a.filter((e) => e.agent_id === "coordinator").length;
    const responses = a2a.length - requests;
    let state: EdgeState = "idle";
    if (v.status === "failed") state = "failed";
    else if (v.status === "completed") state = "completed";
    else if (isActive(v.status) && a2a.length > 0) state = "active";
    result[id] = { id, state, requests, responses };
  }
  return result;
}

/** Events that correspond to a real message travelling over the network. */
const PULSE_TYPES = new Set(["a2a_request", "a2a_task", "a2a_artifact", "discovery_request", "discovery_response"]);

export interface Pulse {
  key: string;
  specialist: SpecialistId;
  direction: "out" | "in";
  kind: "discovery" | "task" | "result";
}

export function pulseForEvent(event: ExecutionEvent): Pulse | null {
  if (event.channel !== "a2a" || !PULSE_TYPES.has(event.type)) return null;
  const outbound = event.agent_id === "coordinator";
  const specialist = (outbound ? event.target_agent_id : event.agent_id) as SpecialistId | null;
  if (!specialist || specialist === ("coordinator" as AgentId)) return null;
  const kind = event.type.startsWith("discovery") ? "discovery" : event.type === "a2a_artifact" ? "result" : "task";
  return { key: event.id, specialist, direction: outbound ? "out" : "in", kind };
}
