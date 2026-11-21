"use client";

import { useEffect, useState } from "react";

import { formatMoney, titleCase } from "@/lib/format";
import type { Attraction, DestinationResearch } from "@/lib/types";

const CATEGORY_TINT: Record<string, string> = {
  beach: "var(--agent-itinerary)",
  adventure: "var(--st-retrying)",
  food: "var(--agent-budget)",
  culture: "var(--agent-coordinator)",
  history: "var(--agent-coordinator)",
  nature: "var(--agent-destination)",
  nightlife: "var(--st-discovering)",
  shopping: "var(--st-pending)",
  relaxation: "var(--st-available)",
};

const imageCache = new Map<string, string | null>();

/** Lazily loads a thumbnail from the public Wikipedia REST API; null on any failure. */
function useWikipediaImage(title: string | null): string | null {
  const [src, setSrc] = useState<string | null>(() => (title ? (imageCache.get(title) ?? null) : null));
  useEffect(() => {
    if (!title || imageCache.has(title)) return;
    const controller = new AbortController();
    fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`, {
      signal: controller.signal,
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { thumbnail?: { source?: string } } | null) => {
        const url = data?.thumbnail?.source ?? null;
        imageCache.set(title, url);
        setSrc(url);
      })
      .catch(() => {
        if (!controller.signal.aborted) imageCache.set(title, null);
      });
    return () => controller.abort();
  }, [title]);
  return src;
}

function AttractionCard({ a, currency }: { a: Attraction; currency: string }) {
  const src = useWikipediaImage(a.wikipedia_title);
  const tint = CATEGORY_TINT[a.category.toLowerCase()] ?? "var(--accent)";
  return (
    <article className="flex flex-col overflow-hidden rounded-xl border border-line bg-surface" data-testid="attraction">
      <div className="relative h-32 overflow-hidden" style={{ background: `linear-gradient(135deg, color-mix(in srgb, ${tint} 30%, var(--surface-2)), var(--surface-2))` }}>
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element -- external, unknown-size Wikipedia thumbnails
          <img src={src} alt={a.name} loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-end p-3">
            <span className="text-2xl font-semibold tracking-tight" style={{ color: `color-mix(in srgb, ${tint} 75%, var(--text))` }}>
              {titleCase(a.category)}
            </span>
          </div>
        )}
        <span className="absolute left-2 top-2 rounded-md bg-surface/90 px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-fg backdrop-blur">
          {a.category}
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <div>
          <h4 className="text-sm font-semibold text-fg">{a.name}</h4>
          <p className="text-[11.5px] text-faint">{a.area}</p>
        </div>
        <p className="text-[12.5px] leading-relaxed text-muted">{a.description}</p>
        <p className="text-[12px] text-fg">
          <span className="font-medium">Why: </span>
          <span className="text-muted">{a.rationale}</span>
        </p>
        <div className="mt-auto flex flex-wrap gap-x-3 gap-y-1 border-t border-line pt-2 text-[11.5px] text-muted">
          <span>
            <span className="font-mono tabular-nums text-fg">{a.estimated_cost_per_person > 0 ? formatMoney(a.estimated_cost_per_person, currency) : "Free"}</span> / person
          </span>
          <span>{a.visit_duration_hours} h visit</span>
          <span>Best: {a.best_time_of_day}</span>
        </div>
      </div>
    </article>
  );
}

export function DestinationList({ research, currency }: { research: DestinationResearch; currency: string }) {
  return (
    <div className="space-y-5" data-testid="destination-list">
      <p className="text-sm leading-relaxed text-muted">{research.destination_overview}</p>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {research.attractions.map((a) => (
          <AttractionCard key={a.name} a={a} currency={currency} />
        ))}
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {research.local_food.length ? (
          <div className="md:col-span-2">
            <p className="mb-2 text-xs font-semibold text-fg">Local food to try</p>
            <ul className="grid gap-2 sm:grid-cols-2">
              {research.local_food.map((f) => (
                <li key={f.name} className="rounded-lg bg-surface-2 px-3 py-2">
                  <p className="flex justify-between gap-2 text-[13px] font-medium text-fg">
                    {f.name}
                    <span className="font-mono text-[11.5px] tabular-nums text-muted">{formatMoney(f.estimated_cost_per_person, currency)}</span>
                  </p>
                  <p className="text-[11.5px] text-muted">{f.description}</p>
                  <p className="text-[11px] text-faint">Try at: {f.where_to_try}</p>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="space-y-3 text-xs">
          {research.best_areas_to_stay.length ? (
            <div>
              <p className="mb-1 font-semibold text-fg">Where to stay</p>
              <p className="text-muted">{research.best_areas_to_stay.join(", ")}</p>
            </div>
          ) : null}
          <div>
            <p className="mb-1 font-semibold text-fg">Getting around</p>
            <p className="text-muted">{research.getting_around}</p>
          </div>
          {research.notes.length ? (
            <ul className="list-disc space-y-1 pl-4 text-muted">
              {research.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </div>
  );
}
