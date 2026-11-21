"use client";

import { useState, type FormEvent } from "react";

import type { TravelStyle, TripRequest } from "@/lib/types";

export const CURRENCIES = ["PHP", "USD", "EUR", "JPY", "SGD", "GBP", "AUD", "KRW", "THB", "IDR"];
export const INTEREST_PRESETS = [
  "Beaches",
  "Adventure",
  "Local food",
  "Culture",
  "History",
  "Nature",
  "Nightlife",
  "Shopping",
  "Relaxation",
  "Photography",
];
const STYLES: { value: TravelStyle; label: string }[] = [
  { value: "budget", label: "Budget" },
  { value: "balanced", label: "Balanced" },
  { value: "comfort", label: "Comfort" },
  { value: "luxury", label: "Luxury" },
];

export interface TripFormValues {
  destination: string;
  origin: string;
  start_date: string;
  end_date: string;
  days: string;
  travelers: string;
  budget: string;
  currency: string;
  interests: string[];
  travel_style: TravelStyle;
  preferences: string;
}

export const EMPTY_FORM: TripFormValues = {
  destination: "",
  origin: "",
  start_date: "",
  end_date: "",
  days: "3",
  travelers: "1",
  budget: "",
  currency: "PHP",
  interests: [],
  travel_style: "balanced",
  preferences: "",
};

export const DEMO_FORM: TripFormValues = {
  destination: "Cebu, Philippines",
  origin: "Manila",
  start_date: "",
  end_date: "",
  days: "3",
  travelers: "1",
  budget: "10000",
  currency: "PHP",
  interests: ["Beaches", "Adventure", "Local food"],
  travel_style: "budget",
  preferences:
    "I'm planning a 3-day trip to Cebu with a ₱10,000 budget. I enjoy beaches, adventure activities, and local food.",
};

export type FormErrors = Partial<Record<keyof TripFormValues, string>>;

function daysBetween(start: string, end: string): number {
  const a = new Date(`${start}T00:00:00Z`).getTime();
  const b = new Date(`${end}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000) + 1;
}

/** Mirrors backend TripRequest validation (backend/shared/schemas.py). */
export function validateTrip(values: TripFormValues): { errors: FormErrors; request: TripRequest | null } {
  const errors: FormErrors = {};
  const destination = values.destination.trim();
  if (destination.length < 2) errors.destination = "Enter a destination (at least 2 characters).";
  else if (destination.length > 100) errors.destination = "Destination is too long.";

  let days = Number(values.days);
  if (values.start_date && values.end_date) {
    const span = daysBetween(values.start_date, values.end_date);
    if (span < 1) errors.end_date = "Return date must be on or after the departure date.";
    else if (span > 14) errors.end_date = "Trips longer than 14 days are not supported.";
    else days = span;
  }
  if (!Number.isInteger(days) || days < 1 || days > 14) errors.days = "Duration must be between 1 and 14 days.";

  const travelers = Number(values.travelers);
  if (!Number.isInteger(travelers) || travelers < 1 || travelers > 20) errors.travelers = "Travelers must be between 1 and 20.";

  const budget = Number(values.budget);
  if (!values.budget.trim() || !Number.isFinite(budget) || budget <= 0) errors.budget = "Enter a budget greater than zero.";

  if (!/^[A-Za-z]{3}$/.test(values.currency)) errors.currency = "Use a 3-letter currency code.";
  if (values.preferences.length > 600) errors.preferences = "Keep preferences under 600 characters.";

  if (Object.keys(errors).length) return { errors, request: null };
  return {
    errors,
    request: {
      destination,
      origin: values.origin.trim() || null,
      start_date: values.start_date || null,
      end_date: values.end_date || null,
      days,
      travelers,
      budget,
      currency: values.currency.toUpperCase(),
      interests: values.interests,
      travel_style: values.travel_style,
      preferences: values.preferences.trim() || null,
    },
  };
}

const inputCls =
  "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg placeholder:text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 disabled:opacity-60";

function FieldShell({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-muted">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} role="alert" className="mt-1 text-xs text-danger-fg">
          {error}
        </p>
      ) : hint ? (
        <p className="mt-1 text-[11px] text-faint">{hint}</p>
      ) : null}
    </div>
  );
}

interface Props {
  onSubmit: (request: TripRequest) => void;
  disabled?: boolean;
  submitting?: boolean;
}

export function TripForm({ onSubmit, disabled = false, submitting = false }: Props) {
  const [values, setValues] = useState<TripFormValues>(EMPTY_FORM);
  const [errors, setErrors] = useState<FormErrors>({});
  const [customInterest, setCustomInterest] = useState("");

  const set = <K extends keyof TripFormValues>(key: K, value: TripFormValues[K]) => {
    setValues((prev) => {
      const next = { ...prev, [key]: value };
      if ((key === "start_date" || key === "end_date") && next.start_date && next.end_date) {
        const span = daysBetween(next.start_date, next.end_date);
        if (span >= 1 && span <= 14) next.days = String(span);
      }
      return next;
    });
    setErrors((prev) => ({ ...prev, [key]: undefined }));
  };

  const toggleInterest = (interest: string) => {
    const has = values.interests.some((i) => i.toLowerCase() === interest.toLowerCase());
    set("interests", has ? values.interests.filter((i) => i.toLowerCase() !== interest.toLowerCase()) : [...values.interests, interest].slice(0, 12));
  };

  const addCustom = () => {
    const v = customInterest.trim().slice(0, 40);
    if (v && !values.interests.some((i) => i.toLowerCase() === v.toLowerCase())) set("interests", [...values.interests, v].slice(0, 12));
    setCustomInterest("");
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const { errors: errs, request } = validateTrip(values);
    setErrors(errs);
    if (request) onSubmit(request);
  };

  const datesSet = Boolean(values.start_date && values.end_date);
  const allInterests = [...INTEREST_PRESETS, ...values.interests.filter((i) => !INTEREST_PRESETS.some((p) => p.toLowerCase() === i.toLowerCase()))];

  return (
    <form onSubmit={handleSubmit} noValidate aria-label="Trip request" className="space-y-4">
      <button
        type="button"
        onClick={() => {
          setValues(DEMO_FORM);
          setErrors({});
        }}
        disabled={disabled}
        className="group w-full rounded-xl border border-dashed border-accent/60 bg-accent-soft px-3 py-2.5 text-left transition-colors hover:border-accent disabled:opacity-60"
      >
        <span className="block text-xs font-semibold text-accent">Load demo scenario</span>
        <span className="block text-[13px] text-fg">3-day Cebu trip, ₱10,000 — beaches, adventure, local food</span>
      </button>

      <FieldShell id="destination" label="Destination" error={errors.destination}>
        <input
          id="destination"
          className={inputCls}
          value={values.destination}
          onChange={(e) => set("destination", e.target.value)}
          placeholder="e.g. Cebu, Philippines"
          aria-invalid={Boolean(errors.destination)}
          disabled={disabled}
          maxLength={100}
        />
      </FieldShell>

      <FieldShell id="origin" label="Starting location (optional)">
        <input id="origin" className={inputCls} value={values.origin} onChange={(e) => set("origin", e.target.value)} placeholder="e.g. Manila" disabled={disabled} maxLength={100} />
      </FieldShell>

      <div className="grid grid-cols-2 gap-3">
        <FieldShell id="start_date" label="Departure">
          <input id="start_date" type="date" className={inputCls} value={values.start_date} onChange={(e) => set("start_date", e.target.value)} disabled={disabled} />
        </FieldShell>
        <FieldShell id="end_date" label="Return" error={errors.end_date}>
          <input
            id="end_date"
            type="date"
            className={inputCls}
            value={values.end_date}
            min={values.start_date || undefined}
            onChange={(e) => set("end_date", e.target.value)}
            aria-invalid={Boolean(errors.end_date)}
            disabled={disabled}
          />
        </FieldShell>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <FieldShell id="days" label="Duration (days)" error={errors.days} hint={datesSet ? "Calculated from dates" : undefined}>
          <input
            id="days"
            type="number"
            min={1}
            max={14}
            className={inputCls}
            value={values.days}
            onChange={(e) => set("days", e.target.value)}
            readOnly={datesSet}
            aria-invalid={Boolean(errors.days)}
            disabled={disabled}
          />
        </FieldShell>
        <FieldShell id="travelers" label="Travelers" error={errors.travelers}>
          <input
            id="travelers"
            type="number"
            min={1}
            max={20}
            className={inputCls}
            value={values.travelers}
            onChange={(e) => set("travelers", e.target.value)}
            aria-invalid={Boolean(errors.travelers)}
            disabled={disabled}
          />
        </FieldShell>
      </div>

      <div className="grid grid-cols-[1fr_auto] gap-3">
        <FieldShell id="budget" label="Total budget" error={errors.budget}>
          <input
            id="budget"
            type="number"
            min={1}
            step="any"
            className={inputCls}
            value={values.budget}
            onChange={(e) => set("budget", e.target.value)}
            placeholder="10000"
            aria-invalid={Boolean(errors.budget)}
            disabled={disabled}
          />
        </FieldShell>
        <FieldShell id="currency" label="Currency" error={errors.currency}>
          <select id="currency" className={inputCls} value={values.currency} onChange={(e) => set("currency", e.target.value)} disabled={disabled}>
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </FieldShell>
      </div>

      <fieldset>
        <legend className="mb-1.5 text-xs font-medium text-muted">Interests</legend>
        <div className="flex flex-wrap gap-1.5">
          {allInterests.map((interest) => {
            const on = values.interests.some((i) => i.toLowerCase() === interest.toLowerCase());
            return (
              <button
                key={interest}
                type="button"
                aria-pressed={on}
                onClick={() => toggleInterest(interest)}
                disabled={disabled}
                className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                  on ? "border-accent bg-accent text-accent-fg" : "border-line text-muted hover:border-line-strong hover:text-fg"
                }`}
              >
                {interest}
              </button>
            );
          })}
        </div>
        <div className="mt-2 flex gap-2">
          <input
            aria-label="Add a custom interest"
            className={`${inputCls} py-1.5 text-xs`}
            value={customInterest}
            onChange={(e) => setCustomInterest(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addCustom();
              }
            }}
            placeholder="Add your own"
            disabled={disabled}
            maxLength={40}
          />
          <button type="button" onClick={addCustom} disabled={disabled} className="rounded-lg border border-line px-3 text-xs font-medium text-muted hover:bg-surface-2">
            Add
          </button>
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-1.5 text-xs font-medium text-muted">Travel style</legend>
        <div role="radiogroup" aria-label="Travel style" className="grid grid-cols-4 rounded-lg border border-line bg-surface-2 p-0.5">
          {STYLES.map((s) => (
            <button
              key={s.value}
              type="button"
              role="radio"
              aria-checked={values.travel_style === s.value}
              onClick={() => set("travel_style", s.value)}
              disabled={disabled}
              className={`rounded-md px-1 py-1.5 text-xs font-medium transition-colors ${
                values.travel_style === s.value ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </fieldset>

      <FieldShell id="preferences" label="Additional preferences (optional)" error={errors.preferences}>
        <textarea
          id="preferences"
          rows={3}
          className={`${inputCls} resize-y`}
          value={values.preferences}
          onChange={(e) => set("preferences", e.target.value)}
          placeholder="Dietary needs, pace, must-see places…"
          disabled={disabled}
          maxLength={600}
        />
      </FieldShell>

      <button
        type="submit"
        disabled={disabled || submitting}
        className="w-full rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-accent-fg shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? "Submitting to coordinator…" : "Plan my trip with the agents"}
      </button>
    </form>
  );
}
