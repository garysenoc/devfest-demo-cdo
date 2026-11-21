"use client";

import { useState } from "react";

import { agentDuration, isActive, type AgentView } from "@/lib/agent-state";
import { formatClock, formatDuration, shortId } from "@/lib/format";
import { AGENT_COLOR, STATUS_META } from "@/lib/status";
import { Chip, CopyButton, JsonView } from "@/components/ui/primitives";
import { StatusBadge } from "./StatusBadge";

interface Props {
  view: AgentView;
  now: number;
  selected?: boolean;
  onSelect?: () => void;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10.5px] font-semibold uppercase tracking-wider text-faint">{label}</dt>
      <dd className="mt-0.5 truncate text-[13px] text-fg">{children}</dd>
    </div>
  );
}

export function AgentCard({ view, now, selected = false, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const color = AGENT_COLOR[view.id];
  const active = isActive(view.status);
  const duration = agentDuration(view, now);
  const statusColor = STATUS_META[view.status].color;

  return (
    <article
      data-testid={`agent-card-${view.id}`}
      aria-label={view.name}
      className={`panel relative flex flex-col overflow-hidden transition-shadow ${selected ? "ring-2" : ""}`}
      style={selected ? ({ "--tw-ring-color": color } as React.CSSProperties) : undefined}
    >
      <div className="h-1 w-full" style={{ background: color, opacity: active ? 1 : 0.55 }} />
      {active ? (
        <div
          aria-hidden
          className="anim-glow pointer-events-none absolute inset-x-0 top-0 h-16"
          style={{ background: `linear-gradient(to bottom, color-mix(in srgb, ${statusColor} 22%, transparent), transparent)` }}
        />
      ) : null}
      <div className="relative flex flex-1 flex-col gap-3 p-4">
        <header className="flex items-start justify-between gap-2">
          <button type="button" onClick={onSelect} className="min-w-0 text-left">
            <h3 className="truncate text-sm font-semibold text-fg">{view.name}</h3>
            <p className="mt-0.5 text-xs text-muted">{view.role}</p>
          </button>
          <StatusBadge status={view.status} />
        </header>

        <p className="line-clamp-2 text-xs leading-relaxed text-muted">{view.description}</p>

        <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5">
          <Field label="Service">
            {view.url ? (
              <span className="font-mono text-[12px]" title={view.url}>
                {view.url.replace(/^https?:\/\//, "")}
              </span>
            ) : (
              <span className="text-faint">—</span>
            )}
          </Field>
          <Field label="Availability">
            <span
              data-testid="availability"
              className={view.availability === "available" ? "text-fg" : "text-faint"}
            >
              {view.availability === "available" ? "Card discovered" : view.availability === "offline" ? "Unreachable" : "Checking"}
            </span>
          </Field>
          <Field label="Task ID">
            {view.taskId ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="font-mono text-[12px]" title={view.taskId} data-testid="task-id">
                  {shortId(view.taskId)}
                </span>
                <CopyButton value={view.taskId} label="Copy" />
              </span>
            ) : (
              <span className="text-faint">—</span>
            )}
          </Field>
          <Field label="Duration">
            <span className="font-mono text-[12px] tabular-nums" data-testid="duration">
              {formatDuration(duration)}
            </span>
            {view.attempts > 1 ? <span className="ml-1.5 text-[11px] text-muted">attempt {view.attempts}</span> : null}
          </Field>
        </dl>

        <div className="space-y-2 rounded-lg bg-surface-2 p-2.5">
          <div>
            <p className="text-[10.5px] font-semibold uppercase tracking-wider text-faint">Current task</p>
            <p className="mt-0.5 line-clamp-2 text-[12.5px] text-fg" data-testid="current-task">
              {view.currentTask ?? <span className="text-faint">Idle — waiting for a travel request</span>}
            </p>
          </div>
          <div>
            <p className="text-[10.5px] font-semibold uppercase tracking-wider text-faint">Latest activity</p>
            <p className="mt-0.5 line-clamp-2 text-[12.5px] text-muted" data-testid="latest-activity">
              {view.latestActivity ?? "No activity yet"}
            </p>
          </div>
          {view.outputSummary ? (
            <div>
              <p className="text-[10.5px] font-semibold uppercase tracking-wider text-faint">Output</p>
              <p className="mt-0.5 line-clamp-3 text-[12.5px] text-fg" data-testid="output-summary">
                {view.outputSummary}
              </p>
            </div>
          ) : null}
        </div>

        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="mt-auto self-start text-xs font-medium text-accent hover:underline"
        >
          {open ? "Hide execution details" : "Show execution details"}
        </button>

        {open ? (
          <div className="space-y-3 border-t border-line pt-3 text-xs">
            {view.info?.skills?.length ? (
              <div>
                <p className="mb-1.5 font-semibold text-fg">Skills (from Agent Card)</p>
                <ul className="space-y-1.5">
                  {view.info.skills.map((s) => (
                    <li key={s.id}>
                      <span className="font-medium text-fg">{s.name}</span>
                      <span className="text-muted"> — {s.description}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {view.info?.card_url ? (
              <p className="text-muted">
                Agent Card:{" "}
                <a className="font-mono text-accent hover:underline" href={view.info.card_url} target="_blank" rel="noreferrer">
                  {view.info.card_url}
                </a>
              </p>
            ) : null}
            {view.info?.card ? <JsonView value={view.info.card} maxHeight={220} /> : null}
            <div>
              <p className="mb-1.5 font-semibold text-fg">Events for this agent ({view.events.length})</p>
              {view.events.length === 0 ? (
                <p className="text-muted">No events in the current execution.</p>
              ) : (
                <ol className="max-h-48 space-y-1 overflow-auto">
                  {view.events.map((e) => (
                    <li key={e.id} className="flex gap-2">
                      <span className="shrink-0 font-mono text-faint">{formatClock(e.timestamp)}</span>
                      <Chip tone={e.channel === "a2a" ? "a2a" : "internal"}>{e.channel === "a2a" ? "A2A" : "int"}</Chip>
                      <span className="text-muted">{e.message}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </article>
  );
}
