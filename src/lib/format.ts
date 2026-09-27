/**
 * Display formatting.
 *
 * Percentages are always shown as percentages and probabilities as percentages,
 * because that is how a retention manager reads them. Raw SHAP values are shown
 * as signed numbers with a stated unit, never as probabilities, because they are
 * not probabilities.
 */

const NUMBER_FORMAT = new Intl.NumberFormat("en-GB");

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return NUMBER_FORMAT.format(value);
}

/** Format a 0..1 fraction as a percentage. */
export function formatPercent(
  value: number | null | undefined,
  digits = 1,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

/** A signed number, for SHAP contributions and lift factors. */
export function formatSigned(
  value: number | null | undefined,
  digits = 3,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const rendered = value.toFixed(digits);
  return value > 0 ? `+${rendered}` : rendered;
}

export function formatDate(
  value: string | Date | null | undefined,
  style: "long" | "short" | "time" | "full" = "long",
): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";

  switch (style) {
    case "short":
      return new Intl.DateTimeFormat("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      }).format(date);
    case "time":
      return new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(date);
    case "full":
      return new Intl.DateTimeFormat("en-GB", {
        dateStyle: "full",
        timeStyle: "short",
      }).format(date);
    default:
      return new Intl.DateTimeFormat("en-GB", {
        dateStyle: "long",
      }).format(date);
  }
}

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600_000],
  ["month", 30 * 24 * 3600_000],
  ["week", 7 * 24 * 3600_000],
  ["day", 24 * 3600_000],
  ["hour", 3600_000],
  ["minute", 60_000],
];

/** "3 days ago", with the absolute time available as a title attribute. */
export function formatRelative(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";

  const elapsed = date.getTime() - Date.now();
  const formatter = new Intl.RelativeTimeFormat("en-GB", { numeric: "auto" });

  for (const [unit, ms] of RELATIVE_UNITS) {
    if (Math.abs(elapsed) >= ms || unit === "minute") {
      return formatter.format(Math.round(elapsed / ms), unit);
    }
  }
  return formatter.format(0, "minute");
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
    return "—";
  }
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** Human labels for the risk bands. */
export function riskLabel(risk: string): string {
  if (risk === "high") return "High risk";
  if (risk === "medium") return "Medium risk";
  if (risk === "low") return "Low risk";
  return risk;
}

/** Turn a snake_case identifier into readable words. */
export function humanise(value: string): string {
  return value
    .replace(/[._]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

const PRIORITY_TONE: Record<string, "neutral" | "caution" | "critical"> = {
  low: "neutral",
  medium: "caution",
  high: "critical",
  critical: "critical",
};

export function priorityTone(priority: string) {
  return PRIORITY_TONE[priority] ?? "neutral";
}
