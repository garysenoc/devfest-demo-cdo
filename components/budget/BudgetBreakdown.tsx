import { formatMoney, titleCase } from "@/lib/format";
import type { BudgetCategory, BudgetPlan } from "@/lib/types";

export const CATEGORY_COLOR: Record<BudgetCategory | "contingency", string> = {
  transportation: "var(--agent-itinerary)",
  accommodation: "var(--agent-coordinator)",
  food: "var(--agent-budget)",
  activities: "var(--agent-destination)",
  miscellaneous: "var(--st-offline)",
  contingency: "var(--st-retrying)",
};

export function BudgetBreakdown({ budget }: { budget: BudgetPlan }) {
  const cur = budget.currency;
  const segments = [
    ...budget.category_totals.filter((c) => c.amount > 0).map((c) => ({ key: c.category, amount: c.amount })),
    ...(budget.contingency_amount > 0 ? [{ key: "contingency" as const, amount: budget.contingency_amount }] : []),
  ];
  // Scale the bar to whichever is larger so an overrun is visible past the budget line.
  const scale = Math.max(budget.budget, budget.total_estimated) || 1;
  const budgetMarker = (budget.budget / scale) * 100;
  const usedPct = budget.budget > 0 ? Math.round((budget.total_estimated / budget.budget) * 100) : 0;

  return (
    <div className="space-y-5" data-testid="budget-breakdown">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Estimated total" value={formatMoney(budget.total_estimated, cur)} sub={`${usedPct}% of budget`} />
        <Stat
          label={budget.over_budget ? "Over budget by" : "Remaining"}
          value={formatMoney(budget.over_budget ? budget.overrun_amount : budget.remaining, cur)}
          tone={budget.over_budget ? "danger" : "success"}
          testId="budget-remaining"
        />
        <Stat label="Per person" value={formatMoney(budget.per_person_total, cur)} sub={`${budget.travelers} traveler${budget.travelers === 1 ? "" : "s"} · ${budget.days} days`} />
      </div>

      <div>
        <div className="relative">
          <div className="flex h-5 w-full overflow-hidden rounded-full bg-surface-3" role="img" aria-label="Budget allocation by category">
            {segments.map((s) => (
              <div
                key={s.key}
                data-testid={`budget-segment-${s.key}`}
                title={`${titleCase(s.key)}: ${formatMoney(s.amount, cur)}`}
                style={{ width: `${(s.amount / scale) * 100}%`, background: CATEGORY_COLOR[s.key] }}
                className="h-full border-r border-surface last:border-r-0"
              />
            ))}
          </div>
          <div className="absolute -top-1 bottom-[-4px] w-0.5 rounded bg-fg" style={{ left: `calc(${budgetMarker}% - 1px)` }} aria-hidden />
        </div>
        <div className="mt-1 flex justify-between text-[11px] text-faint">
          <span>0</span>
          <span>Budget {formatMoney(budget.budget, cur)}</span>
        </div>
        <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-3">
          {segments.map((s) => (
            <li key={s.key} className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-muted">
                <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: CATEGORY_COLOR[s.key] }} />
                {s.key === "contingency" ? `Contingency (${budget.contingency_percent}%)` : titleCase(s.key)}
              </span>
              <span className="font-mono tabular-nums text-fg">{formatMoney(s.amount, cur)}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-left text-xs">
          <thead className="bg-surface-2 text-[10.5px] uppercase tracking-wider text-faint">
            <tr>
              <th className="px-3 py-2 font-semibold">Category</th>
              <th className="px-3 py-2 font-semibold">Item</th>
              <th className="px-3 py-2 text-right font-semibold">Estimate</th>
            </tr>
          </thead>
          <tbody>
            {budget.line_items.map((item, i) => (
              <tr key={i} className="border-t border-line align-top">
                <td className="whitespace-nowrap px-3 py-2 text-muted">{titleCase(item.category)}</td>
                <td className="px-3 py-2">
                  <p className="text-fg">{item.description}</p>
                  <p className="text-[11px] text-faint">{item.basis}</p>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right font-mono tabular-nums text-fg">{formatMoney(item.amount, budget.currency)}</td>
              </tr>
            ))}
            <tr className="border-t border-line">
              <td className="px-3 py-2 text-muted" colSpan={2}>
                Contingency ({budget.contingency_percent}% of {formatMoney(budget.subtotal, cur)})
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-fg">{formatMoney(budget.contingency_amount, cur)}</td>
            </tr>
            <tr className="border-t border-line-strong bg-surface-2 font-semibold">
              <td className="px-3 py-2 text-fg" colSpan={2}>
                Total estimate
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-fg">{formatMoney(budget.total_estimated, cur)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {budget.cost_saving_tips.length ? (
          <div>
            <p className="mb-1.5 text-xs font-semibold text-fg">Cost-saving alternatives</p>
            <ul className="list-disc space-y-1 pl-4 text-xs text-muted">
              {budget.cost_saving_tips.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {budget.assumptions.length ? (
          <div>
            <p className="mb-1.5 text-xs font-semibold text-fg">Assumptions</p>
            <ul className="list-disc space-y-1 pl-4 text-xs text-muted">
              {budget.assumptions.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
  testId,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "success" | "danger";
  testId?: string;
}) {
  const color = tone === "danger" ? "text-danger-fg" : tone === "success" ? "text-success-fg" : "text-fg";
  return (
    <div className="rounded-lg bg-surface-2 px-3 py-2.5" data-testid={testId}>
      <p className="text-[10.5px] font-semibold uppercase tracking-wider text-faint">{label}</p>
      <p className={`mt-0.5 text-lg font-semibold tabular-nums ${color}`}>{value}</p>
      {sub ? <p className="text-[11px] text-muted">{sub}</p> : null}
    </div>
  );
}
