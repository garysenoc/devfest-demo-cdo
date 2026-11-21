"use client";

import { useState } from "react";

import { AGENT_META } from "@/lib/agent-state";
import { formatDate, formatMoney } from "@/lib/format";
import { AGENT_COLOR } from "@/lib/status";
import type { TravelPlan } from "@/lib/types";
import { BudgetBreakdown } from "@/components/budget/BudgetBreakdown";
import { ItineraryView } from "@/components/itinerary/ItineraryView";
import { DestinationList } from "./DestinationList";
import { RefinePanel } from "./RefinePanel";

type Tab = "itinerary" | "destinations" | "budget" | "tips";
const TABS: { id: Tab; label: string }[] = [
  { id: "itinerary", label: "Daily itinerary" },
  { id: "destinations", label: "Recommendations" },
  { id: "budget", label: "Budget" },
  { id: "tips", label: "Travel tips" },
];

function Overview({ plan }: { plan: TravelPlan }) {
  const o = plan.overview;
  const dates = o.start_date && o.end_date ? `${formatDate(o.start_date)} – ${formatDate(o.end_date)}` : "Flexible dates";
  const items: [string, string, string?][] = [
    ["Destination", o.destination],
    ["Dates", dates],
    ["Duration", `${o.days} day${o.days === 1 ? "" : "s"}`],
    ["Travelers", String(o.travelers)],
    ["Budget", formatMoney(o.budget, o.currency)],
    ["Estimated total", formatMoney(o.estimated_total, o.currency)],
    [o.over_budget ? "Over budget" : "Remaining", formatMoney(Math.abs(o.remaining), o.currency), o.over_budget ? "danger" : "success"],
  ];
  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-4 xl:grid-cols-7" data-testid="trip-overview">
      {items.map(([k, v, tone]) => (
        <div key={k} className="bg-surface px-3 py-2.5">
          <dt className="text-[10.5px] font-semibold uppercase tracking-wider text-faint">{k}</dt>
          <dd className={`mt-0.5 truncate text-sm font-semibold ${tone === "danger" ? "text-danger-fg" : tone === "success" ? "text-success-fg" : "text-fg"}`}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function TipList({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="rounded-xl border border-line p-4">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-faint">{title}</p>
      <ul className="list-disc space-y-1 pl-4 text-[13px] text-muted">
        {items.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>
    </div>
  );
}

export function PlanView({
  plan,
  onRefine,
  refineDisabled,
}: {
  plan: TravelPlan;
  onRefine: (instruction: string) => void;
  refineDisabled: boolean;
}) {
  const [tab, setTab] = useState<Tab>("itinerary");
  const s = plan.summary;
  return (
    <section className="panel p-4 sm:p-6" aria-label="Travel plan" data-testid="plan-view">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">
            {plan.refinement_instruction ? "Refined travel plan" : "Your travel plan"}
          </p>
          <h2 className="mt-0.5 text-xl font-semibold tracking-tight text-fg">{s.headline}</h2>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted">{s.summary}</p>
          {plan.refinement_instruction ? (
            <p className="mt-2 text-xs text-muted">
              Refinement: <span className="font-medium text-fg">&ldquo;{plan.refinement_instruction}&rdquo;</span>
            </p>
          ) : null}
        </div>
        <div className="text-right">
          <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-faint">Agents invoked</p>
          <div className="flex flex-wrap justify-end gap-1" data-testid="agents-invoked">
            {plan.agents_invoked.map((id) => (
              <span
                key={id}
                className="rounded-md border px-1.5 py-0.5 text-[11px] font-medium"
                style={{ color: AGENT_COLOR[id], borderColor: `color-mix(in srgb, ${AGENT_COLOR[id]} 40%, transparent)` }}
              >
                {AGENT_META[id].short}
              </span>
            ))}
          </div>
        </div>
      </div>

      <Overview plan={plan} />

      {plan.consistency.length ? (
        <ul className="mt-3 space-y-1" data-testid="consistency">
          {plan.consistency.map((c, i) => (
            <li
              key={i}
              className={`rounded-lg border px-3 py-1.5 text-xs ${c.level === "warning" ? "border-warning-line bg-warning-bg text-warning-fg" : "border-line bg-surface-2 text-muted"}`}
            >
              <span className="font-semibold">{c.level === "warning" ? "Check: " : "Note: "}</span>
              {c.message}
            </li>
          ))}
        </ul>
      ) : null}

      <div role="tablist" aria-label="Plan sections" className="mt-5 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              tab === t.id ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="pt-4" role="tabpanel">
        {tab === "itinerary" ? <ItineraryView itinerary={plan.itinerary} /> : null}
        {tab === "destinations" ? <DestinationList research={plan.destination} currency={plan.overview.currency} /> : null}
        {tab === "budget" ? <BudgetBreakdown budget={plan.budget} /> : null}
        {tab === "tips" ? (
          <div className="grid gap-3 md:grid-cols-2">
            <TipList title="Packing list" items={s.packing_list} />
            <TipList title="Local recommendations" items={s.local_recommendations} />
            <TipList title="Safety reminders" items={s.safety_reminders} />
            <TipList title="Cost-saving suggestions" items={s.cost_saving_suggestions} />
            <TipList title="Alternative destinations" items={s.alternative_destinations} />
          </div>
        ) : null}
      </div>

      <p className="mt-5 rounded-lg border border-line bg-surface-2 px-3 py-2 text-[11.5px] text-muted" data-testid="disclaimer">
        {plan.disclaimer}
      </p>

      <div className="mt-5 border-t border-line pt-5">
        <h3 className="mb-2 text-sm font-semibold text-fg">Refine this plan</h3>
        <RefinePanel onRefine={onRefine} disabled={refineDisabled} />
      </div>
    </section>
  );
}
