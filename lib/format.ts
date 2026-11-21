/** Formatting helpers shared by the dashboard and plan views. */

const moneyFormatters = new Map<string, Intl.NumberFormat>();

export function formatMoney(amount: number | null | undefined, currency: string): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return "—";
  const code = (currency || "USD").toUpperCase();
  let fmt = moneyFormatters.get(code);
  if (!fmt) {
    try {
      fmt = new Intl.NumberFormat("en", { style: "currency", currency: code, maximumFractionDigits: 0 });
    } catch {
      fmt = new Intl.NumberFormat("en", { maximumFractionDigits: 0 });
    }
    moneyFormatters.set(code, fmt);
  }
  return fmt.format(amount);
}

/** "850 ms", "12.3 s", "2m 05s". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || ms < 0 || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

/** Wall-clock time with milliseconds, e.g. "14:03:07.412". */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  const ss = d.getSeconds().toString().padStart(2, "0");
  const ms = d.getMilliseconds().toString().padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

/** Offset from execution start, e.g. "+1.234s". */
export function formatOffset(ms: number): string {
  if (Number.isNaN(ms)) return "";
  return `+${(Math.max(0, ms) / 1000).toFixed(3)}s`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" });
}

export function shortId(id: string | null | undefined, length = 8): string {
  if (!id) return "—";
  return id.length > length ? `${id.slice(0, length)}…` : id;
}

export function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function toMs(iso: string): number {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
}
