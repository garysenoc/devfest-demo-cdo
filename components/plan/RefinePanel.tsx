"use client";

import { useState, type FormEvent } from "react";

export const REFINE_SUGGESTIONS = [
  "Make the trip cheaper",
  "Add more adventure activities",
  "Make it more relaxing",
  "Add an extra day",
  "Reduce transportation costs",
  "Replace one attraction with something less touristy",
];

export function RefinePanel({
  onRefine,
  disabled,
}: {
  onRefine: (instruction: string) => void;
  disabled: boolean;
}) {
  const [text, setText] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = text.trim();
    if (v.length < 3) return;
    onRefine(v);
    setText("");
  };
  return (
    <form onSubmit={submit} aria-label="Refine plan" className="space-y-3">
      <p className="text-xs text-muted">
        The coordinator decides which specialists need to run again and re-invokes only those over A2A. The rest of the plan is reused.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {REFINE_SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            disabled={disabled}
            onClick={() => onRefine(s)}
            className="rounded-full border border-line px-2.5 py-1 text-xs font-medium text-muted transition-colors hover:border-accent hover:text-fg disabled:opacity-50"
          >
            {s}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          aria-label="Refinement instruction"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={400}
          disabled={disabled}
          placeholder="Or describe a change, e.g. swap day 2 for island hopping"
          className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg placeholder:text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25"
        />
        <button
          type="submit"
          disabled={disabled || text.trim().length < 3}
          className="shrink-0 rounded-lg bg-accent px-4 text-sm font-semibold text-accent-fg disabled:opacity-50"
        >
          Refine
        </button>
      </div>
    </form>
  );
}
