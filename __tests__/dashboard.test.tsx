import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ActivityTimeline } from "@/components/activity-timeline/ActivityTimeline";
import { AgentCard } from "@/components/agents/AgentCard";
import { StatusBadge } from "@/components/agents/StatusBadge";
import { AgentGraph } from "@/components/agent-graph/AgentGraph";
import { CommunicationInspector, extractArtifacts } from "@/components/communication-inspector/CommunicationInspector";
import { deriveAgentViews } from "@/lib/agent-state";
import type { AgentStatus } from "@/lib/types";
import { AGENTS, destinationFlow, makeEvent } from "./fixtures";

const ALL_STATUSES: AgentStatus[] = ["offline", "discovering", "available", "pending", "running", "communicating", "completed", "failed", "retrying"];

describe("StatusBadge", () => {
  it("renders a distinct label and icon for every state", () => {
    render(
      <div>
        {ALL_STATUSES.map((s) => (
          <StatusBadge key={s} status={s} />
        ))}
      </div>,
    );
    const badges = screen.getAllByTestId("status-badge");
    expect(badges.map((b) => b.textContent)).toEqual(["Offline", "Discovering", "Available", "Pending", "Running", "Communicating", "Completed", "Failed", "Retrying"]);
    const icons = badges.map((b) => b.querySelector("svg")?.innerHTML);
    expect(new Set(icons).size).toBe(ALL_STATUSES.length);
  });
});

describe("AgentCard", () => {
  it("shows status, task, task id, duration and output summary", async () => {
    const view = deriveAgentViews(destinationFlow(), AGENTS).destination;
    render(<AgentCard view={view} now={0} />);
    const card = screen.getByTestId("agent-card-destination");
    expect(within(card).getByTestId("status-badge")).toHaveAttribute("data-status", "completed");
    expect(within(card).getByTestId("current-task")).toHaveTextContent("Research attractions in Cebu");
    expect(within(card).getByTestId("task-id")).toHaveTextContent("task-des");
    expect(within(card).getByTestId("duration")).toHaveTextContent("2.5 s");
    expect(within(card).getByTestId("output-summary")).toHaveTextContent("6 attractions");
    await userEvent.click(within(card).getByRole("button", { name: /show execution details/i }));
    expect(within(card).getByText(/destination skill/)).toBeInTheDocument();
    expect(within(card).getByText(/Events for this agent \(7\)/)).toBeInTheDocument();
  });

  it("shows an offline agent", () => {
    const view = deriveAgentViews([], AGENTS.map((a) => ({ ...a, status: "offline" as const })) ).budget;
    render(<AgentCard view={view} now={0} />);
    expect(screen.getByTestId("status-badge")).toHaveAttribute("data-status", "offline");
    expect(screen.getByTestId("availability")).toHaveTextContent("Unreachable");
  });
});

describe("ActivityTimeline", () => {
  it("renders events in seq order with channel badges", () => {
    const events = destinationFlow();
    render(<ActivityTimeline events={[events[3], events[0], events[1]]} />);
    const items = screen.getAllByTestId("timeline-item");
    expect(items.map((i) => i.getAttribute("data-seq"))).toEqual(["1", "2", "4"]);
    expect(within(items[1]).getByText("A2A")).toBeInTheDocument();
    expect(within(items[0]).getByText("Internal")).toBeInTheDocument();
    expect(within(items[2]).getByText("+1.500s")).toBeInTheDocument();
  });

  it("explains the empty state", () => {
    render(<ActivityTimeline events={[]} />);
    expect(screen.getByText(/no activity yet/i)).toBeInTheDocument();
  });
});

describe("CommunicationInspector", () => {
  function setup(agentFilter: null | "destination" | "budget" = null) {
    const onSelectEvent = vi.fn();
    const utils = render(
      <CommunicationInspector events={destinationFlow()} agentFilter={agentFilter} onAgentFilterChange={() => undefined} selectedEventId={null} onSelectEvent={onSelectEvent} />,
    );
    return { ...utils, onSelectEvent };
  }

  it("shows only A2A traffic by default and can include internal events", async () => {
    setup();
    let rows = screen.getAllByTestId("inspector-row");
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.getAttribute("data-channel") === "a2a")).toBe(true);
    await userEvent.click(screen.getByLabelText(/include internal events/i));
    rows = screen.getAllByTestId("inspector-row");
    expect(rows).toHaveLength(9);
  });

  it("filters by agent", () => {
    setup("budget");
    expect(screen.queryAllByTestId("inspector-row")).toHaveLength(0);
    expect(screen.getByText(/no messages match/i)).toBeInTheDocument();
  });

  it("shows request and artifact details for a selected message", () => {
    const events = destinationFlow();
    render(<CommunicationInspector events={events} agentFilter={null} onAgentFilterChange={() => undefined} selectedEventId={events[6].id} onSelectEvent={() => undefined} />);
    const detail = screen.getByTestId("inspector-detail");
    expect(within(detail).getByText("TaskArtifactUpdateEvent")).toBeInTheDocument();
    expect(within(detail).getByText("Returned artifact")).toBeInTheDocument();
    expect(within(detail).getAllByText(/Kawasan Falls/).length).toBeGreaterThan(0);
    expect(extractArtifacts(events[6].payload)).toEqual([{ attractions: [{ name: "Kawasan Falls" }] }]);
  });
});

describe("AgentGraph", () => {
  it("animates pulses only for real A2A events that arrive after mount", () => {
    const onSelect = vi.fn();
    const views = deriveAgentViews([], AGENTS);
    const { rerender } = render(<AgentGraph views={views} events={[]} executionId="exec-1" selected={null} onSelect={onSelect} />);
    expect(screen.queryAllByTestId("pulse")).toHaveLength(0);

    const internalOnly = [makeEvent({ seq: 1, type: "execution_started", status: "running" }), makeEvent({ seq: 2, type: "orchestration", message: "Planning" })];
    rerender(<AgentGraph views={deriveAgentViews(internalOnly, AGENTS)} events={internalOnly} executionId="exec-1" selected={null} onSelect={onSelect} />);
    expect(screen.queryAllByTestId("pulse")).toHaveLength(0);

    const flow = destinationFlow();
    rerender(<AgentGraph views={deriveAgentViews(flow, AGENTS)} events={flow} executionId="exec-1" selected={null} onSelect={onSelect} />);
    const pulses = screen.getAllByTestId("pulse");
    // discovery_request, discovery_response, a2a_request, a2a_task, a2a_artifact
    expect(pulses).toHaveLength(5);
    expect(pulses.filter((p) => p.getAttribute("data-direction") === "out")).toHaveLength(2);
    expect(screen.getByTestId("edge-destination")).toHaveAttribute("data-state", "completed");
    expect(screen.getByTestId("graph-node-destination")).toHaveAttribute("data-status", "completed");
  });

  it("does not replay pulses for events recovered before mount", () => {
    const flow = destinationFlow();
    render(<AgentGraph views={deriveAgentViews(flow, AGENTS)} events={flow} executionId="exec-1" selected={null} onSelect={() => undefined} />);
    expect(screen.queryAllByTestId("pulse")).toHaveLength(0);
  });

  it("selects a node on click and keyboard", () => {
    const onSelect = vi.fn();
    render(<AgentGraph views={deriveAgentViews([], AGENTS)} events={[]} executionId={null} selected={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId("graph-node-budget"));
    fireEvent.keyDown(screen.getByTestId("graph-node-itinerary"), { key: "Enter" });
    expect(onSelect.mock.calls).toEqual([["budget"], ["itinerary"]]);
  });
});
