"use client";

import { useState } from "react";

import { AGENT_META, sortEvents } from "@/lib/agent-state";
import { formatClock, shortId, titleCase } from "@/lib/format";
import { AGENT_COLOR } from "@/lib/status";
import type { AgentId, ExecutionEvent } from "@/lib/types";
import { Chip, JsonView } from "@/components/ui/primitives";

interface Props {
  events: ExecutionEvent[];
  agentFilter: AgentId | null;
  onAgentFilterChange: (id: AgentId | null) => void;
  selectedEventId: string | null;
  onSelectEvent: (id: string | null) => void;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

function metaString(e: ExecutionEvent, key: string): string | null {
  const v = e.metadata?.[key];
  return typeof v === "string" && v ? v : null;
}

/** Pull returned artifact data out of a TaskArtifactUpdateEvent payload. */
export function extractArtifacts(payload: unknown): unknown[] {
  if (!isRec(payload)) return [];
  const update = isRec(payload.artifactUpdate) ? payload.artifactUpdate : payload;
  const artifact = isRec(update.artifact) ? update.artifact : null;
  if (!artifact || !Array.isArray(artifact.parts)) return [];
  return artifact.parts.map((p) => (isRec(p) ? (p.data ?? p.text ?? p) : p));
}

/** Pull the task object sent in a SendStreamingMessage request. */
export function extractRequestParts(payload: unknown): unknown[] {
  if (!isRec(payload)) return [];
  const message = isRec(payload.message) ? payload.message : null;
  if (!message || !Array.isArray(message.parts)) return [];
  return message.parts.map((p) => (isRec(p) ? (p.data ?? p.text ?? p) : p));
}

function involves(e: ExecutionEvent, id: AgentId) {
  return e.agent_id === id || e.target_agent_id === id;
}

function messageType(e: ExecutionEvent): string {
  return metaString(e, "message_type") ?? titleCase(e.type);
}

function Endpoint({ id }: { id: AgentId }) {
  return (
    <span className="inline-flex items-center gap-1 font-medium" style={{ color: AGENT_COLOR[id] }}>
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: AGENT_COLOR[id] }} aria-hidden />
      {AGENT_META[id].short}
    </span>
  );
}

function Detail({ event }: { event: ExecutionEvent }) {
  const artifacts = event.type === "a2a_artifact" ? extractArtifacts(event.payload) : [];
  const requestParts = event.type === "a2a_request" ? extractRequestParts(event.payload) : [];
  const rows: [string, React.ReactNode][] = [
    ["Channel", event.channel === "a2a" ? "A2A network traffic" : "Internal orchestration (not sent over the network)"],
    ["Source", <Endpoint key="s" id={event.agent_id} />],
    ["Target", event.target_agent_id ? <Endpoint key="t" id={event.target_agent_id} /> : "—"],
    ["Message type", messageType(event)],
    ["Task ID", event.task_id ? <span key="tid" className="font-mono">{event.task_id}</span> : "—"],
    ["Task state", metaString(event, "task_state") ?? "—"],
    ["Endpoint", metaString(event, "endpoint") ? <span key="ep" className="font-mono">{metaString(event, "endpoint")}</span> : "—"],
    ["Timestamp", <span key="ts" className="font-mono">{event.timestamp}</span>],
  ];
  return (
    <div className="space-y-3" data-testid="inspector-detail">
      <p className="text-sm font-medium text-fg">{event.message}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-faint">{k}</dt>
            <dd className="min-w-0 break-all text-fg">{v}</dd>
          </div>
        ))}
      </dl>
      {requestParts.length ? (
        <div>
          <p className="mb-1 text-xs font-semibold text-fg">Request summary — task sent to the agent</p>
          <JsonView value={requestParts.length === 1 ? requestParts[0] : requestParts} maxHeight={220} />
        </div>
      ) : null}
      {artifacts.length ? (
        <div>
          <p className="mb-1 text-xs font-semibold text-fg">Returned artifact</p>
          <JsonView value={artifacts.length === 1 ? artifacts[0] : artifacts} maxHeight={260} />
        </div>
      ) : null}
      {event.payload !== null && event.payload !== undefined ? (
        <details>
          <summary className="cursor-pointer text-xs font-semibold text-fg">Sanitized {event.channel === "a2a" ? "protocol" : "event"} payload</summary>
          <div className="mt-2">
            <JsonView value={event.payload} />
          </div>
        </details>
      ) : null}
      {Object.keys(event.metadata ?? {}).length ? (
        <details>
          <summary className="cursor-pointer text-xs font-semibold text-fg">Metadata</summary>
          <div className="mt-2">
            <JsonView value={event.metadata} maxHeight={180} />
          </div>
        </details>
      ) : null}
    </div>
  );
}

export function CommunicationInspector({ events, agentFilter, onAgentFilterChange, selectedEventId, onSelectEvent }: Props) {
  const [includeInternal, setIncludeInternal] = useState(false);
  const rows = sortEvents(events).filter(
    (e) => (includeInternal || e.channel === "a2a") && (!agentFilter || involves(e, agentFilter)),
  );
  const selected = events.find((e) => e.id === selectedEventId) ?? null;
  const a2aCount = events.filter((e) => e.channel === "a2a").length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Filter by agent" className="flex flex-wrap gap-1">
          {([null, "coordinator", "destination", "budget", "itinerary"] as (AgentId | null)[]).map((id) => (
            <button
              key={id ?? "all"}
              type="button"
              aria-pressed={agentFilter === id}
              onClick={() => onAgentFilterChange(id)}
              className={`rounded-md border px-2 py-1 text-[11.5px] font-medium transition-colors ${
                agentFilter === id ? "border-accent bg-accent-soft text-fg" : "border-line text-muted hover:bg-surface-2"
              }`}
            >
              {id ? AGENT_META[id].short : "All agents"}
            </button>
          ))}
        </div>
        <label className="ml-auto inline-flex cursor-pointer items-center gap-1.5 text-[11.5px] text-muted">
          <input
            type="checkbox"
            checked={includeInternal}
            onChange={(e) => setIncludeInternal(e.target.checked)}
            className="accent-[var(--accent)]"
          />
          Include internal events
        </label>
      </div>
      <p className="text-[11.5px] text-muted">
        <Chip tone="a2a">A2A</Chip> rows are real protocol messages captured by the coordinator&apos;s A2A client
        ({a2aCount} so far). <Chip>Internal</Chip> rows are orchestration steps that never leave the coordinator.
      </p>

      <div className="grid gap-3 2xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="max-h-[320px] overflow-auto rounded-lg border border-line 2xl:max-h-[420px]">
          {rows.length === 0 ? (
            <p className="p-4 text-center text-xs text-muted">No messages match this filter yet.</p>
          ) : (
            <table className="w-full text-left text-[12px]" data-testid="inspector-table">
              <thead className="sticky top-0 bg-surface-2 text-[10.5px] uppercase tracking-wider text-faint">
                <tr>
                  <th className="px-2 py-1.5 font-semibold">Time</th>
                  <th className="px-2 py-1.5 font-semibold">Route</th>
                  <th className="px-2 py-1.5 font-semibold">Type</th>
                  <th className="hidden px-2 py-1.5 font-semibold sm:table-cell">Task</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr
                    key={e.id}
                    data-testid="inspector-row"
                    data-channel={e.channel}
                    onClick={() => onSelectEvent(e.id)}
                    className={`cursor-pointer border-t border-line align-top hover:bg-surface-2 ${selectedEventId === e.id ? "bg-accent-soft" : ""}`}
                  >
                    <td className="whitespace-nowrap px-2 py-1.5 font-mono text-[11px] text-faint">{formatClock(e.timestamp)}</td>
                    <td className="px-2 py-1.5">
                      <span className="inline-flex flex-wrap items-center gap-1">
                        <Endpoint id={e.agent_id} />
                        {e.target_agent_id ? (
                          <>
                            <span className="text-faint" aria-label="to">
                              -&gt;
                            </span>
                            <Endpoint id={e.target_agent_id} />
                          </>
                        ) : null}
                      </span>
                    </td>
                    <td className="px-2 py-1.5">
                      <span className="flex flex-col gap-0.5">
                        <span className="inline-flex items-center gap-1">
                          <Chip tone={e.channel === "a2a" ? "a2a" : "internal"}>{e.channel === "a2a" ? "A2A" : "Int"}</Chip>
                          <span className="text-fg">{messageType(e)}</span>
                        </span>
                        {metaString(e, "task_state") ? (
                          <span className="font-mono text-[10.5px] text-muted">{metaString(e, "task_state")?.replace("TASK_STATE_", "")}</span>
                        ) : null}
                      </span>
                    </td>
                    <td className="hidden px-2 py-1.5 font-mono text-[11px] text-muted sm:table-cell">{shortId(e.task_id)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="max-h-[480px] overflow-auto rounded-lg border border-line p-3">
          {selected ? (
            <Detail event={selected} />
          ) : (
            <p className="py-8 text-center text-xs text-muted">Select a message to inspect its source, target, task state and sanitized payload.</p>
          )}
        </div>
      </div>
    </div>
  );
}
