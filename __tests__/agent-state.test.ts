import { describe, expect, it } from "vitest";

import { agentDuration, deriveAgentViews, deriveEdges, pulseForEvent } from "@/lib/agent-state";
import { AGENTS, destinationFlow, makeEvent } from "./fixtures";

describe("deriveAgentViews", () => {
  it("starts from Agent Card availability before any events", () => {
    const offline = AGENTS.map((a) => (a.id === "budget" ? { ...a, status: "offline" as const } : a));
    const views = deriveAgentViews([], offline);
    expect(views.destination.status).toBe("available");
    expect(views.budget.status).toBe("offline");
    expect(views.budget.availability).toBe("offline");
    expect(views.itinerary.currentTask).toBeNull();
  });

  it("tracks status, task id, current task and summary from real events", () => {
    const views = deriveAgentViews(destinationFlow(), AGENTS);
    const d = views.destination;
    expect(d.status).toBe("completed");
    expect(d.taskId).toBe("task-dest-123456789");
    expect(d.currentTask).toBe("Research attractions in Cebu");
    expect(d.outputSummary).toBe("6 attractions, 4 local dishes");
    expect(d.attempts).toBe(1);
    // started at the a2a_request (seq 4), finished at completion (seq 9) => 5 * 500ms
    expect(agentDuration(d, 0)).toBe(2500);
    expect(views.coordinator.status).toBe("communicating");
  });

  it("applies statuses in seq order even if events arrive out of order", () => {
    const events = destinationFlow().reverse();
    expect(deriveAgentViews(events, AGENTS).destination.status).toBe("completed");
  });

  it("handles failure, retry and attempt numbers", () => {
    const base = destinationFlow().slice(0, 6);
    const events = [
      ...base,
      makeEvent({ seq: 7, type: "a2a_error", channel: "a2a", agent_id: "destination", target_agent_id: "coordinator", status: "failed", message: "Destination timed out", metadata: { attempt: 1 } }),
      makeEvent({ seq: 8, type: "agent_status", agent_id: "destination", status: "retrying", message: "Retrying destination", metadata: { attempt: 2 } }),
    ];
    let d = deriveAgentViews(events, AGENTS).destination;
    expect(d.status).toBe("retrying");
    expect(d.attempts).toBe(2);
    expect(d.finishedAt).toBeNull();

    const failed = [...events, makeEvent({ seq: 9, type: "agent_status", agent_id: "destination", status: "failed", message: "Destination failed after 2 attempts" })];
    d = deriveAgentViews(failed, AGENTS).destination;
    expect(d.status).toBe("failed");
    expect(d.finishedAt).not.toBeNull();
    expect(deriveEdges(deriveAgentViews(failed, AGENTS)).destination.state).toBe("failed");
  });

  it("uses a live clock for running agents", () => {
    const events = destinationFlow().slice(0, 6);
    const d = deriveAgentViews(events, AGENTS).destination;
    const startedAt = d.startedAt as number;
    expect(agentDuration(d, startedAt + 4200)).toBe(4200);
  });

  it("marks agents offline when discovery fails", () => {
    const events = [
      makeEvent({ seq: 1, type: "discovery_response", channel: "a2a", agent_id: "budget", target_agent_id: "coordinator", status: "offline", message: "Budget card unreachable", metadata: { error: true } }),
    ];
    const b = deriveAgentViews(events, AGENTS).budget;
    expect(b.status).toBe("offline");
    expect(b.availability).toBe("offline");
  });
});

describe("edges and pulses", () => {
  it("derives edge states", () => {
    const edges = deriveEdges(deriveAgentViews(destinationFlow(), AGENTS));
    expect(edges.destination.state).toBe("completed");
    expect(edges.destination.requests).toBe(2); // discovery_request + a2a_request
    expect(edges.budget.state).toBe("idle");
  });

  it("creates pulses only for real network events", () => {
    const flow = destinationFlow();
    const pulses = flow.map(pulseForEvent);
    expect(pulses[0]).toBeNull(); // execution_started (internal)
    expect(pulses[3]).toMatchObject({ specialist: "destination", direction: "out", kind: "task" });
    expect(pulses[5]).toBeNull(); // status update: no pulse
    expect(pulses[6]).toMatchObject({ direction: "in", kind: "result" });
    expect(pulses[7]).toBeNull(); // validation (internal)
  });
});
