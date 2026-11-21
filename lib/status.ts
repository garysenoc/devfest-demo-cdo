import type { AgentId, AgentStatus } from "./types";

export interface StatusMeta {
  label: string;
  color: string; // CSS colour expression (token)
  description: string;
}

export const STATUS_META: Record<AgentStatus, StatusMeta> = {
  offline: { label: "Offline", color: "var(--st-offline)", description: "Agent Card could not be reached" },
  discovering: { label: "Discovering", color: "var(--st-discovering)", description: "Fetching the Agent Card" },
  available: { label: "Available", color: "var(--st-available)", description: "Agent Card discovered and valid" },
  pending: { label: "Pending", color: "var(--st-pending)", description: "A2A task submitted, waiting to start" },
  running: { label: "Running", color: "var(--st-running)", description: "Agent is working on its task" },
  communicating: { label: "Communicating", color: "var(--st-communicating)", description: "Exchanging A2A messages" },
  completed: { label: "Completed", color: "var(--st-completed)", description: "Task completed and result validated" },
  failed: { label: "Failed", color: "var(--st-failed)", description: "Task failed or result was invalid" },
  retrying: { label: "Retrying", color: "var(--st-retrying)", description: "Resubmitting the A2A task" },
};

export const AGENT_COLOR: Record<AgentId, string> = {
  coordinator: "var(--agent-coordinator)",
  destination: "var(--agent-destination)",
  budget: "var(--agent-budget)",
  itinerary: "var(--agent-itinerary)",
};
