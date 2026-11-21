import { STATUS_META } from "@/lib/status";
import type { AgentStatus } from "@/lib/types";

/** Each state has a distinct glyph so status never relies on colour alone. */
export function StatusIcon({ status, size = 14 }: { status: AgentStatus; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (status) {
    case "offline":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M4.2 11.8 11.8 4.2" />
        </svg>
      );
    case "discovering":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.5" strokeDasharray="2.5 2.5" className="anim-spin" />
          <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
        </svg>
      );
    case "available":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.5" />
          <circle cx="8" cy="8" r="2.2" fill="currentColor" stroke="none" />
        </svg>
      );
    case "pending":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M8 5v3.2l2 1.3" />
        </svg>
      );
    case "running":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.5" opacity="0.25" />
          <path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5" className="anim-spin" />
        </svg>
      );
    case "communicating":
      return (
        <svg {...common}>
          <path d="M3 6h9l-2.5-2.5M13 10H4l2.5 2.5" />
        </svg>
      );
    case "completed":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.5" />
          <path d="m5.6 8.2 1.7 1.7 3.2-3.4" />
        </svg>
      );
    case "failed":
      return (
        <svg {...common}>
          <path d="M8 2.2 14 13H2Z" />
          <path d="M8 6.5v2.8M8 11.2v.1" />
        </svg>
      );
    case "retrying":
      return (
        <svg {...common}>
          <path d="M12.8 7.2A4.9 4.9 0 1 0 12 11" />
          <path d="M13 3.5v3.7H9.3" />
        </svg>
      );
  }
}

export function StatusBadge({ status, className = "" }: { status: AgentStatus; className?: string }) {
  const meta = STATUS_META[status];
  return (
    <span
      data-testid="status-badge"
      data-status={status}
      title={meta.description}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${className}`}
      style={{
        color: meta.color,
        borderColor: `color-mix(in srgb, ${meta.color} 35%, transparent)`,
        background: `color-mix(in srgb, ${meta.color} 10%, transparent)`,
      }}
    >
      <StatusIcon status={status} size={13} />
      {meta.label}
    </span>
  );
}
