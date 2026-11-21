"use client";

import { useState, type ReactNode } from "react";

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* clipboard blocked */
        }
      }}
      className="rounded-md border border-line px-2 py-0.5 text-[11px] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg"
      aria-label={`${label} to clipboard`}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

export function JsonView({ value, maxHeight = 320 }: { value: unknown; maxHeight?: number }) {
  const text = JSON.stringify(value, null, 2) ?? "null";
  return (
    <div className="relative">
      <div className="absolute right-2 top-2">
        <CopyButton value={text} label="Copy JSON" />
      </div>
      <pre
        className="overflow-auto rounded-lg border border-line bg-surface-2 p-3 pr-24 font-mono text-[11.5px] leading-relaxed text-fg"
        style={{ maxHeight }}
      >
        {text}
      </pre>
    </div>
  );
}

export function SectionHeader({
  eyebrow,
  title,
  aside,
}: {
  eyebrow?: string;
  title: string;
  aside?: ReactNode;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
      <div>
        {eyebrow ? (
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">{eyebrow}</p>
        ) : null}
        <h2 className="text-base font-semibold tracking-tight text-fg">{title}</h2>
      </div>
      {aside}
    </div>
  );
}

export function Banner({
  tone,
  title,
  children,
  action,
}: {
  tone: "warning" | "danger" | "info";
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const styles =
    tone === "danger"
      ? "border-danger-line bg-danger-bg text-danger-fg"
      : tone === "warning"
        ? "border-warning-line bg-warning-bg text-warning-fg"
        : "border-line bg-accent-soft text-fg";
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={`flex flex-wrap items-start justify-between gap-3 rounded-xl border px-4 py-3 text-sm ${styles}`}>
      <div className="min-w-0">
        <p className="font-semibold">{title}</p>
        {children ? <div className="mt-0.5 opacity-90">{children}</div> : null}
      </div>
      {action}
    </div>
  );
}

export function Chip({ children, tone = "default" }: { children: ReactNode; tone?: "default" | "a2a" | "internal" }) {
  const style =
    tone === "a2a"
      ? { color: "var(--st-communicating)", borderColor: "color-mix(in srgb, var(--st-communicating) 40%, transparent)", background: "color-mix(in srgb, var(--st-communicating) 10%, transparent)" }
      : undefined;
  return (
    <span
      className={`inline-flex items-center rounded-md border px-1.5 py-px text-[10.5px] font-semibold uppercase tracking-wide ${tone === "default" || tone === "internal" ? "border-line bg-surface-2 text-muted" : ""}`}
      style={style}
    >
      {children}
    </span>
  );
}
