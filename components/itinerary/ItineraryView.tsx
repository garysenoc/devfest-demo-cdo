import { formatDate, formatMoney } from "@/lib/format";
import type { ItineraryActivity, ItineraryPlan } from "@/lib/types";

const SLOT_LABEL: Record<ItineraryActivity["time_slot"], string> = {
  morning: "Morning",
  afternoon: "Afternoon",
  evening: "Evening",
};

export function ItineraryView({ itinerary }: { itinerary: ItineraryPlan }) {
  const cur = itinerary.currency;
  return (
    <div className="space-y-4" data-testid="itinerary">
      {itinerary.days.map((day) => (
        <section key={day.day} className="rounded-xl border border-line" aria-label={`Day ${day.day}`}>
          <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line bg-surface-2 px-4 py-2.5">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-fg">
                Day {day.day}
                {day.date ? <span className="ml-2 font-normal text-muted">{formatDate(day.date)}</span> : null}
                <span className="ml-2 font-normal text-muted">· {day.theme}</span>
              </h3>
              <p className="text-[11.5px] text-faint">Area focus: {day.area_focus}</p>
            </div>
            <p className="text-xs text-muted">
              Day estimate <span className="font-mono font-semibold tabular-nums text-fg" data-testid={`day-total-${day.day}`}>{formatMoney(day.estimated_cost, cur)}</span>
            </p>
          </header>
          <ol className="divide-y divide-line">
            {day.activities.map((a, i) => (
              <li key={i} className="grid grid-cols-[4.5rem_1fr] gap-3 px-4 py-3 sm:grid-cols-[6rem_1fr_auto]">
                <div>
                  <p className="font-mono text-sm font-semibold tabular-nums text-fg">{a.start_time}</p>
                  <p className="text-[11px] text-faint">{SLOT_LABEL[a.time_slot]}</p>
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-fg">{a.title}</p>
                  <p className="text-[12.5px] leading-relaxed text-muted">{a.description}</p>
                  <p className="mt-1 text-[11.5px] text-faint">
                    <span className="font-medium text-muted">{a.location}</span>
                    {a.transport_note ? <> · {a.transport_note}</> : null}
                  </p>
                  <p className="mt-1 font-mono text-[11.5px] tabular-nums text-fg sm:hidden">{formatMoney(a.estimated_cost, cur)}</p>
                </div>
                <p className="hidden whitespace-nowrap text-right font-mono text-[12.5px] tabular-nums text-fg sm:block">
                  {a.estimated_cost > 0 ? formatMoney(a.estimated_cost, cur) : "Free"}
                </p>
              </li>
            ))}
          </ol>
          {day.notes.length ? (
            <ul className="space-y-0.5 border-t border-line px-4 py-2.5 text-[11.5px] text-muted">
              {day.notes.map((n, i) => (
                <li key={i}>Note: {n}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ))}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-2 px-4 py-2.5 text-sm">
        <span className="text-muted">Itinerary activities and meals, all days</span>
        <span className="font-mono font-semibold tabular-nums text-fg">{formatMoney(itinerary.total_estimated_cost, cur)}</span>
      </div>
      {itinerary.general_tips.length ? (
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted">
          {itinerary.general_tips.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
