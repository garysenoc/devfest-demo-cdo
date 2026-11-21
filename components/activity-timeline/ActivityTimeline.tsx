"use client";

import { useEffect, useRef, useState } from "react";

import { AGENT_META, sortEvents } from "@/lib/agent-state";
import { formatClock, formatOffset, toMs } from "@/lib/format";
import { AGENT_COLOR, STATUS_META } from "@/lib/status";
import type { ExecutionEvent } from "@/lib/types";
import { Chip } from "@/components/ui/primitives";
import { StatusIcon } from "@/components/agents/StatusBadge";

interface Props {
  events: ExecutionEvent[];
  onSelectEvent?: (event: ExecutionEvent) => void;
  selectedEventId?: string | null;
}

export function ActivityTimeline({ events, onSelectEvent, selectedEventId }: Props) {
  const ordered = sortEvents(events);
  const start = ordered.length ? toMs(ordered[0].timestamp) : 0;
  const listRef = useRef<HTMLOListElement>(null);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const el = listRef.current;
    if (!el || paused) return;
    el.scrollTop = el.scrollHeight;
  }, [ordered.length, paused]);

  if (ordered.length === 0) {
    return (
      <div className="flex h-full min-h-40 flex-col items-center justify-center rounded-xl border border-dashed border-line p-6 text-center text-sm text-muted">
        <p className="font-medium text-fg">No activity yet</p>
        <p className="mt-1 max-w-xs text-xs">
          Every step the coordinator takes and every A2A message it exchanges will appear here as it happens.
        </p>
      </div>
    );
  }

  return (
    <div className="relative">
      {paused ? (
        <span className="absolute right-2 top-2 z-10 rounded-md bg-surface-3 px-2 py-0.5 text-[10.5px] font-medium text-muted">
          Auto-scroll paused
        </span>
      ) : null}
      <ol
        ref={listRef}
        data-testid="timeline"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        className="max-h-[420px] space-y-px overflow-auto pr-1"
        aria-live="polite"
        aria-label="Execution timeline"
      >
        {ordered.map((e) => {
          const color = AGENT_COLOR[e.agent_id];
          const selected = selectedEventId === e.id;
          return (
            <li key={e.id} data-testid="timeline-item" data-seq={e.seq} className="anim-enter">
              <button
                type="button"
                onClick={() => onSelectEvent?.(e)}
                className={`grid w-full grid-cols-[auto_1fr] gap-x-3 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface-2 ${selected ? "bg-surface-2" : ""}`}
              >
                <span className="flex flex-col items-end pt-0.5 font-mono text-[10.5px] leading-tight tabular-nums text-faint">
                  <span>{formatClock(e.timestamp)}</span>
                  <span>{formatOffset(toMs(e.timestamp) - start)}</span>
                </span>
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: color }} aria-hidden />
                    <span className="text-[11.5px] font-semibold" style={{ color }}>
                      {AGENT_META[e.agent_id].short}
                    </span>
                    {e.target_agent_id ? (
                      <span className="text-[11px] text-faint">to {AGENT_META[e.target_agent_id].short}</span>
                    ) : null}
                    <Chip tone={e.channel === "a2a" ? "a2a" : "internal"}>{e.channel === "a2a" ? "A2A" : "Internal"}</Chip>
                    {e.status ? (
                      <span className="inline-flex items-center gap-1 text-[11px]" style={{ color: STATUS_META[e.status].color }}>
                        <StatusIcon status={e.status} size={11} />
                        {STATUS_META[e.status].label}
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block text-[13px] leading-snug text-fg">{e.message}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
