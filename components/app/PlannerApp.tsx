"use client";

import { useState } from "react";

import { useAgents } from "@/hooks/useAgents";
import { useExecution } from "@/hooks/useExecution";
import { useNow } from "@/hooks/useNow";
import { agentDuration, deriveAgentViews } from "@/lib/agent-state";
import { COORDINATOR_URL } from "@/lib/api";
import { formatDuration, formatMoney, shortId } from "@/lib/format";
import type { AgentId, ConnectionState, TripRequest } from "@/lib/types";
import { AgentCard } from "@/components/agents/AgentCard";
import { AgentGraph } from "@/components/agent-graph/AgentGraph";
import { ActivityTimeline } from "@/components/activity-timeline/ActivityTimeline";
import { CommunicationInspector } from "@/components/communication-inspector/CommunicationInspector";
import { TripForm } from "@/components/planner/TripForm";
import { PlanView } from "@/components/plan/PlanView";
import { Banner, SectionHeader } from "@/components/ui/primitives";

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  idle: "No live stream",
  connecting: "Connecting to event stream",
  open: "Live event stream",
  reconnecting: "Reconnecting to event stream",
  closed: "Stream closed",
  error: "Event stream unavailable",
};

function Dot({ color, pulse = false }: { color: string; pulse?: boolean }) {
  return <span className={`inline-block h-2 w-2 rounded-full ${pulse ? "anim-pulse" : ""}`} style={{ background: color }} aria-hidden />;
}

export function PlannerApp() {
  const agentsState = useAgents();
  const { state, start, refine, reset } = useExecution();
  const [selected, setSelected] = useState<AgentId | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(true);
  const [lastRequest, setLastRequest] = useState<TripRequest | null>(null);
  const [mobilePane, setMobilePane] = useState<"timeline" | "inspector">("timeline");

  const running = state.status === "running";
  const now = useNow(running);
  const views = deriveAgentViews(state.events, agentsState.agents);
  const elapsed = agentDuration(views.coordinator, now);

  const offlineSpecialists = agentsState.agents.filter((a) => a.id !== "coordinator" && a.status === "offline");
  const geminiMissing = agentsState.health && !agentsState.health.gemini_configured;

  const handleSubmit = async (request: TripRequest) => {
    setLastRequest(request);
    setSelectedEventId(null);
    const ok = await start(request);
    if (ok) setFormOpen(false);
  };

  const handleRefine = async (instruction: string) => {
    setSelectedEventId(null);
    await refine(instruction);
  };

  const selectAgent = (id: AgentId) => setSelected((cur) => (cur === id ? null : id));
  const summaryRequest = state.plan?.request ?? lastRequest;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-line bg-surface/85 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <svg width="30" height="30" viewBox="0 0 30 30" aria-hidden>
              <rect width="30" height="30" rx="8" fill="var(--accent)" />
              <circle cx="9" cy="15" r="3" fill="var(--accent-text)" />
              <circle cx="21" cy="9" r="2.4" fill="var(--accent-text)" opacity="0.85" />
              <circle cx="21" cy="21" r="2.4" fill="var(--accent-text)" opacity="0.85" />
              <path d="M11.5 14 18.8 10M11.5 16l7.3 4" stroke="var(--accent-text)" strokeWidth="1.4" />
            </svg>
            <div>
              <h1 className="text-[15px] font-semibold leading-tight tracking-tight text-fg">AI Travel Planner</h1>
              <p className="text-[11.5px] text-muted">Google ADK agents collaborating over the A2A protocol, powered by Gemini</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-muted" data-testid="header-status">
            <span className="inline-flex items-center gap-1.5">
              <Dot
                color={agentsState.backendOnline === null ? "var(--st-pending)" : agentsState.backendOnline ? "var(--st-completed)" : "var(--st-failed)"}
              />
              {agentsState.backendOnline === null ? "Checking coordinator" : agentsState.backendOnline ? "Coordinator online" : "Coordinator offline"}
            </span>
            {agentsState.health ? (
              <span className="inline-flex items-center gap-1.5">
                <Dot color={agentsState.health.gemini_configured ? "var(--st-completed)" : "var(--st-pending)"} />
                <span className="font-mono">{agentsState.health.model}</span>
              </span>
            ) : null}
            <span className="inline-flex items-center gap-1.5" data-testid="connection-state" data-state={state.connection}>
              <Dot
                color={
                  state.connection === "open"
                    ? "var(--st-communicating)"
                    : state.connection === "reconnecting" || state.connection === "connecting"
                      ? "var(--st-retrying)"
                      : state.connection === "error"
                        ? "var(--st-failed)"
                        : "var(--st-offline)"
                }
                pulse={state.connection === "open" || state.connection === "reconnecting"}
              />
              {CONNECTION_LABEL[state.connection]}
              {state.connection === "reconnecting" && state.reconnectAttempts ? ` (attempt ${state.reconnectAttempts})` : ""}
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] space-y-4 px-4 py-5 sm:px-6">
        <div className="space-y-2" aria-live="polite">
          {agentsState.backendOnline === false ? (
            <Banner tone="danger" title={`The coordinator is not reachable at ${COORDINATOR_URL}`}>
              Start every service with <code className="rounded bg-surface px-1 font-mono">./scripts/dev.sh</code> from the repository root, then
              this page reconnects automatically.
            </Banner>
          ) : null}
          {geminiMissing ? (
            <Banner tone="warning" title="Gemini is not configured">
              Set <code className="font-mono">GOOGLE_API_KEY</code> (or the Vertex AI variables) in <code className="font-mono">.env</code> and restart the
              backend. Agents cannot plan trips without a model.
            </Banner>
          ) : null}
          {agentsState.backendOnline && offlineSpecialists.length ? (
            <Banner tone="warning" title={`${offlineSpecialists.map((a) => a.name).join(", ")} ${offlineSpecialists.length === 1 ? "is" : "are"} offline`}>
              The coordinator could not fetch {offlineSpecialists.length === 1 ? "its" : "their"} Agent Card. Planning will fail at discovery until{" "}
              {offlineSpecialists.length === 1 ? "it is" : "they are"} started.
            </Banner>
          ) : null}
          {state.error ? (
            <Banner
              tone={state.errorKind === "unavailable" || state.errorKind === "validation" ? "warning" : "danger"}
              title={
                state.status === "failed"
                  ? "The execution failed"
                  : state.errorKind === "validation"
                    ? "The request was rejected"
                    : state.errorKind === "unavailable"
                      ? "Service unavailable"
                      : "Something went wrong"
              }
            >
              {state.error}
            </Banner>
          ) : null}
        </div>

        <div className="grid gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
          <aside className="space-y-4 lg:sticky lg:top-[76px] lg:self-start">
            <section className="panel p-4" aria-label="Travel requirements">
              <SectionHeader
                eyebrow="Step 1"
                title="Travel requirements"
                aside={
                  !formOpen ? (
                    <button type="button" onClick={() => setFormOpen(true)} disabled={running} className="text-xs font-medium text-accent hover:underline disabled:opacity-50">
                      New request
                    </button>
                  ) : null
                }
              />
              {formOpen ? (
                <TripForm onSubmit={handleSubmit} disabled={running} submitting={state.submitting && !running} />
              ) : summaryRequest ? (
                <div className="space-y-2 text-sm" data-testid="request-summary">
                  <p className="font-semibold text-fg">{summaryRequest.destination}</p>
                  <p className="text-muted">
                    {summaryRequest.days} days · {summaryRequest.travelers} traveler{summaryRequest.travelers === 1 ? "" : "s"} ·{" "}
                    {formatMoney(summaryRequest.budget, summaryRequest.currency)}
                  </p>
                  {summaryRequest.interests.length ? <p className="text-xs text-muted">{summaryRequest.interests.join(", ")}</p> : null}
                  <button
                    type="button"
                    onClick={() => {
                      reset();
                      setFormOpen(true);
                    }}
                    disabled={running}
                    className="text-xs font-medium text-muted hover:text-fg disabled:opacity-50"
                  >
                    Clear and start over
                  </button>
                </div>
              ) : null}
            </section>

            <section className="panel p-4 text-xs text-muted" aria-label="How it works">
              <p className="mb-2 font-semibold text-fg">What you will see</p>
              <ol className="list-decimal space-y-1 pl-4">
                <li>The coordinator fetches each specialist&apos;s Agent Card.</li>
                <li>Destination and Budget agents receive A2A tasks at the same time.</li>
                <li>Their results are validated, then sent to the Itinerary agent.</li>
                <li>The coordinator consolidates everything into one plan.</li>
              </ol>
              <p className="mt-2">Every status change below comes from a real backend event.</p>
            </section>
          </aside>

          <div className="min-w-0 space-y-4">
            <section className="panel p-4" aria-label="Agent collaboration">
              <SectionHeader
                eyebrow="Step 2"
                title="Live agent collaboration"
                aside={
                  state.execution ? (
                    <div className="flex flex-wrap items-center gap-3 text-[11.5px] text-muted">
                      <span>
                        {state.kind === "refine" ? "Refinement" : "Execution"} <span className="font-mono text-fg">{shortId(state.execution.id)}</span>
                      </span>
                      <span>
                        Elapsed <span className="font-mono tabular-nums text-fg">{formatDuration(elapsed)}</span>
                      </span>
                      <span
                        className="rounded-md border border-line px-1.5 py-0.5 font-semibold uppercase tracking-wide"
                        data-testid="execution-status"
                      >
                        {state.status}
                      </span>
                    </div>
                  ) : null
                }
              />
              <AgentGraph
                views={views}
                events={state.events}
                executionId={state.execution?.id ?? null}
                selected={selected}
                onSelect={selectAgent}
              />
              <div className="mt-4 grid gap-3 md:grid-cols-2 2xl:grid-cols-4">
                {(["coordinator", "destination", "budget", "itinerary"] as const).map((id) => (
                  <AgentCard key={id} view={views[id]} now={now} selected={selected === id} onSelect={() => selectAgent(id)} />
                ))}
              </div>
            </section>

            <section className="panel p-4" aria-label="Execution activity">
              <div className="mb-3 flex gap-1 xl:hidden" role="tablist" aria-label="Activity views">
                {(["timeline", "inspector"] as const).map((p) => (
                  <button
                    key={p}
                    role="tab"
                    type="button"
                    aria-selected={mobilePane === p}
                    onClick={() => setMobilePane(p)}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium ${mobilePane === p ? "bg-accent-soft text-fg" : "text-muted"}`}
                  >
                    {p === "timeline" ? "Timeline" : "A2A inspector"}
                  </button>
                ))}
              </div>
              <div className="grid gap-5 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
                <div className={mobilePane === "timeline" ? "" : "hidden xl:block"}>
                  <SectionHeader eyebrow="Real-time" title="Execution timeline" aside={<span className="text-[11.5px] text-muted">{state.events.length} events</span>} />
                  <ActivityTimeline events={state.events} selectedEventId={selectedEventId} onSelectEvent={(e) => setSelectedEventId(e.id)} />
                </div>
                <div className={mobilePane === "inspector" ? "" : "hidden xl:block"}>
                  <SectionHeader eyebrow="Protocol" title="A2A communication inspector" />
                  <CommunicationInspector
                    events={state.events}
                    agentFilter={selected}
                    onAgentFilterChange={setSelected}
                    selectedEventId={selectedEventId}
                    onSelectEvent={setSelectedEventId}
                  />
                </div>
              </div>
            </section>

            {state.plan ? (
              <PlanView plan={state.plan} onRefine={handleRefine} refineDisabled={running || state.submitting} />
            ) : (
              <section className="panel flex min-h-40 flex-col items-center justify-center p-8 text-center" aria-label="Travel plan">
                <p className="text-sm font-semibold text-fg">
                  {running ? "The agents are working on your plan" : state.status === "failed" ? "No plan was produced" : "Your travel plan will appear here"}
                </p>
                <p className="mt-1 max-w-md text-xs text-muted">
                  {running
                    ? "The overview, recommendations, itinerary and budget render once the coordinator has validated and consolidated every agent's result."
                    : state.status === "failed"
                      ? "Check the timeline for the failing step, fix the cause, and submit the request again."
                      : "Fill in your travel requirements or load the demo scenario, then watch the agents collaborate."}
                </p>
              </section>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
