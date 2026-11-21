"use client";

import { useState } from "react";

import {
  deriveEdges,
  isActive,
  pulseForEvent,
  type AgentView,
  type EdgeState,
  type Pulse,
  type SpecialistId,
} from "@/lib/agent-state";
import { AGENT_COLOR, STATUS_META } from "@/lib/status";
import type { AgentId, ExecutionEvent } from "@/lib/types";
import { StatusIcon } from "@/components/agents/StatusBadge";

const W = 820;
const H = 380;
const NODE_W = 196;
const NODE_H = 76;

const POS: Record<AgentId, { x: number; y: number }> = {
  coordinator: { x: 122, y: 190 },
  destination: { x: 432, y: 74 },
  budget: { x: 432, y: 306 },
  itinerary: { x: 704, y: 190 },
};

function curve(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(40, Math.abs(x2 - x1) * 0.45);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

const A2A_PATH: Record<SpecialistId, string> = {
  destination: curve(POS.coordinator.x + NODE_W / 2, POS.coordinator.y - 12, POS.destination.x - NODE_W / 2, POS.destination.y),
  budget: curve(POS.coordinator.x + NODE_W / 2, POS.coordinator.y + 12, POS.budget.x - NODE_W / 2, POS.budget.y),
  itinerary: `M ${POS.coordinator.x + NODE_W / 2} ${POS.coordinator.y} L ${POS.itinerary.x - NODE_W / 2} ${POS.itinerary.y}`,
};

const DEP_PATH = {
  destination: curve(POS.destination.x + NODE_W / 2, POS.destination.y, POS.itinerary.x - 20, POS.itinerary.y - NODE_H / 2),
  budget: curve(POS.budget.x + NODE_W / 2, POS.budget.y, POS.itinerary.x - 20, POS.itinerary.y + NODE_H / 2),
};

const EDGE_COLOR: Record<EdgeState, string> = {
  idle: "var(--line-strong)",
  active: "var(--st-communicating)",
  completed: "var(--st-completed)",
  failed: "var(--st-failed)",
};

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

/** SMIL animations inserted after load must be started explicitly. */
function startAnimation(el: SVGAnimationElement | null) {
  if (!el || typeof el.beginElement !== "function" || prefersReducedMotion()) return;
  el.beginElement();
}

function PulseDot({ pulse }: { pulse: Pulse }) {
  const color = pulse.kind === "result" ? "var(--st-completed)" : pulse.kind === "discovery" ? "var(--st-discovering)" : "var(--st-communicating)";
  const reverse = pulse.direction === "in";
  return (
    <g data-testid="pulse" data-direction={pulse.direction} data-specialist={pulse.specialist} opacity="0">
      <circle r="9" fill={color} opacity="0.25" />
      <circle r="4.5" fill={color} />
      <animateMotion
        ref={startAnimation}
        begin="indefinite"
        dur="1.1s"
        fill="freeze"
        path={A2A_PATH[pulse.specialist]}
        keyPoints={reverse ? "1;0" : "0;1"}
        keyTimes="0;1"
        calcMode="linear"
      />
      <animate ref={startAnimation} attributeName="opacity" begin="indefinite" dur="1.1s" values="0;1;1;0" keyTimes="0;0.1;0.85;1" fill="freeze" />
    </g>
  );
}

function Node({
  view,
  selected,
  onSelect,
}: {
  view: AgentView;
  selected: boolean;
  onSelect: (id: AgentId) => void;
}) {
  const { x, y } = POS[view.id];
  const color = AGENT_COLOR[view.id];
  const status = STATUS_META[view.status];
  const active = isActive(view.status);
  const left = x - NODE_W / 2;
  const top = y - NODE_H / 2;
  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={`${view.name}: ${status.label}`}
      aria-pressed={selected}
      data-testid={`graph-node-${view.id}`}
      data-status={view.status}
      onClick={() => onSelect(view.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(view.id);
        }
      }}
      className="cursor-pointer outline-none"
    >
      {active ? (
        <rect x={left - 7} y={top - 7} width={NODE_W + 14} height={NODE_H + 14} rx={20} fill={status.color} className="anim-glow" />
      ) : null}
      <rect
        x={left}
        y={top}
        width={NODE_W}
        height={NODE_H}
        rx={14}
        fill="var(--surface)"
        stroke={selected ? color : active ? status.color : "var(--line-strong)"}
        strokeWidth={selected ? 2.5 : 1.5}
      />
      <rect x={left} y={top + 14} width={4} height={NODE_H - 28} rx={2} fill={color} />
      <text x={left + 18} y={top + 27} fontSize="13.5" fontWeight={600} fill="var(--text)">
        {view.id === "coordinator" ? "Travel Coordinator" : `${view.name.split(" ")[0]} Agent`}
      </text>
      <text x={left + 18} y={top + 44} fontSize="11" fill="var(--text-muted)">
        {view.id === "coordinator" ? "ADK · A2A client" : `ADK · A2A server${view.url ? ` :${view.url.split(":").pop()}` : ""}`}
      </text>
      <g transform={`translate(${left + 18}, ${top + 53})`} style={{ color: status.color }}>
        <StatusIcon status={view.status} size={13} />
        <text x={19} y={10.5} fontSize="11.5" fontWeight={600} fill="currentColor">
          {status.label}
        </text>
      </g>
    </g>
  );
}

interface Props {
  views: Record<AgentId, AgentView>;
  events: ExecutionEvent[];
  executionId: string | null;
  selected: AgentId | null;
  onSelect: (id: AgentId) => void;
}

function maxSeq(events: ExecutionEvent[]) {
  return events.reduce((m, e) => Math.max(m, e.seq), 0);
}

export function AgentGraph({ views, events, executionId, selected, onSelect }: Props) {
  // Events that already existed when the graph mounted (e.g. a recovered
  // snapshot) are not replayed as pulses; only newly arriving traffic animates.
  const [baseline] = useState(() => ({ executionId, seq: maxSeq(events) }));
  const threshold = baseline.executionId === executionId ? baseline.seq : 0;
  const edges = deriveEdges(views);

  const pulses = events
    .filter((e) => e.seq > threshold)
    .map(pulseForEvent)
    .filter((p): p is Pulse => p !== null)
    .slice(-24);

  const itineraryWaiting = views.itinerary.status !== "completed" && (views.destination.status !== "completed" || views.budget.status !== "completed");

  return (
    <div className="graph-grid relative overflow-hidden rounded-xl border border-line">
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="group" aria-label="Agent communication graph">
        <defs>
          <marker id="dep-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill="var(--text-faint)" />
          </marker>
        </defs>

        {/* Data dependencies: itinerary needs destination + budget results (routed via the coordinator). */}
        {(["destination", "budget"] as const).map((id) => (
          <path
            key={`dep-${id}`}
            data-testid={`dep-edge-${id}`}
            d={DEP_PATH[id]}
            fill="none"
            stroke="var(--text-faint)"
            strokeWidth={1.2}
            strokeDasharray="4 5"
            markerEnd="url(#dep-arrow)"
            opacity={views[id].status === "completed" ? 0.9 : 0.5}
          />
        ))}
        <text x={612} y={92} fontSize="10.5" fill="var(--text-faint)" textAnchor="middle">
          data dependency
        </text>
        <text x={612} y={300} fontSize="10.5" fill="var(--text-faint)" textAnchor="middle">
          {itineraryWaiting ? "waits for both results" : "data dependency"}
        </text>

        {/* A2A channels */}
        {(["destination", "budget", "itinerary"] as const).map((id) => {
          const edge = edges[id];
          const color = EDGE_COLOR[edge.state];
          return (
            <g key={`edge-${id}`} data-testid={`edge-${id}`} data-state={edge.state}>
              <path d={A2A_PATH[id]} fill="none" stroke={color} strokeWidth={edge.state === "idle" ? 1.6 : 2.4} strokeLinecap="round" />
              {edge.state === "active" ? (
                <path d={A2A_PATH[id]} fill="none" stroke="var(--surface)" strokeWidth={2.4} strokeDasharray="3 9" className="anim-edge-flow" opacity={0.65} />
              ) : null}
            </g>
          );
        })}
        {(["destination", "budget", "itinerary"] as const).map((id) => {
          const edge = edges[id];
          if (edge.requests + edge.responses === 0) return null;
          const lx = id === "itinerary" ? 415 : 262;
          const ly = id === "destination" ? 116 : id === "budget" ? 270 : 180;
          return (
            <text key={`label-${id}`} x={lx} y={ly} fontSize="10.5" fill="var(--text-muted)" textAnchor="middle" fontFamily="var(--font-geist-mono)">
              {`${edge.requests} out · ${edge.responses} in`}
            </text>
          );
        })}

        {pulses.map((p) => (
          <PulseDot key={p.key} pulse={p} />
        ))}

        {(["coordinator", "destination", "budget", "itinerary"] as const).map((id) => (
          <Node key={id} view={views[id]} selected={selected === id} onSelect={onSelect} />
        ))}
      </svg>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line bg-surface/80 px-3 py-2 text-[11px] text-muted backdrop-blur">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-5 rounded" style={{ background: "var(--st-communicating)" }} /> A2A channel (JSON-RPC over HTTP)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-5 border-t border-dashed" style={{ borderColor: "var(--text-faint)" }} /> Data dependency
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: "var(--st-communicating)" }} /> Live message (real event)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: "var(--st-completed)" }} /> Result artifact
        </span>
        <span className="ml-auto hidden sm:inline">Select a node to inspect it</span>
      </div>
    </div>
  );
}
