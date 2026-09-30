/**
 * Interface primitives.
 *
 * Every interactive element, status indicator and state block in the platform
 * is built from this file, so spacing, colour and focus behaviour stay
 * consistent without each page inventing its own.
 *
 * These are server components unless marked otherwise. Nothing here fetches.
 */

import type { ReactNode } from "react";
// Imported from the shared style module rather than from "./interactive": this
// file is a server module, and a server component may render a client component
// but may not call a function exported from one.
import { buttonClasses } from "./button-styles";

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function PageHeader({
  title,
  description,
  actions,
  breadcrumb,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  breadcrumb?: ReactNode;
}) {
  return (
    <header className="mb-6">
      {breadcrumb ? <div className="mb-2">{breadcrumb}</div> : null}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
          {description ? (
            <div className="mt-1.5 max-w-3xl text-sm text-ink-muted">{description}</div>
          ) : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}

export function Section({
  title,
  description,
  actions,
  children,
  className = "",
}: {
  title?: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`mb-8 ${className}`}>
      {title || actions ? (
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            {title ? (
              <h2 className="text-lg font-semibold tracking-tight text-ink">{title}</h2>
            ) : null}
            {description ? (
              <p className="mt-0.5 max-w-3xl text-sm text-ink-muted">{description}</p>
            ) : null}
          </div>
          {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Card({
  children,
  className = "",
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "article" | "aside";
}) {
  return (
    <Tag
      className={`rounded-card border border-line bg-surface shadow-card ${className}`}
    >
      {children}
    </Tag>
  );
}

export function CardHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {description ? (
          <p className="mt-0.5 text-xs text-ink-subtle">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function CardBody({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`px-4 py-4 ${className}`}>{children}</div>;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type Tone = "neutral" | "positive" | "caution" | "critical" | "info";

const TONE_CLASSES: Record<Tone, string> = {
  neutral: "bg-surface-sunken text-ink-muted ring-line",
  positive: "bg-positive-soft text-positive ring-positive-line",
  caution: "bg-caution-soft text-caution ring-caution-line",
  critical: "bg-critical-soft text-critical ring-critical-line",
  info: "bg-info-soft text-info ring-info-line",
};

const TONE_DOT: Record<Tone, string> = {
  neutral: "bg-ink-faint",
  positive: "bg-positive",
  caution: "bg-caution",
  critical: "bg-critical",
  info: "bg-info",
};

/**
 * A status pill.
 *
 * Colour alone never carries the meaning: the label is always present, so the
 * pill is readable without relying on colour perception.
 */
export function Badge({
  tone = "neutral",
  children,
  dot = false,
  className = "",
}: {
  tone?: Tone;
  children: ReactNode;
  dot?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-2xs font-medium ring-1 ring-inset ${TONE_CLASSES[tone]} ${className}`}
    >
      {dot ? (
        <span
          aria-hidden="true"
          className={`size-1.5 rounded-full ${TONE_DOT[tone]}`}
        />
      ) : null}
      {children}
    </span>
  );
}

export const RISK_TONE: Record<"low" | "medium" | "high", Tone> = {
  low: "positive",
  medium: "caution",
  high: "critical",
};

export function RiskBadge({ risk }: { risk: string }) {
  const tone = RISK_TONE[risk as "low" | "medium" | "high"] ?? "neutral";
  const label =
    risk === "high" ? "High risk" : risk === "medium" ? "Medium risk" : risk === "low" ? "Low risk" : risk;
  return (
    <Badge tone={tone} dot>
      {label}
    </Badge>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const tone: Tone =
    status === "completed" || status === "active" || status === "approved" || status === "ready"
      ? "positive"
      : status === "running" || status === "queued" || status === "evaluating" || status === "in_progress" || status === "preprocessing"
        ? "info"
        : status === "failed" || status === "invalid" || status === "rejected"
          ? "critical"
          : status === "cancelled" || status === "retired"
            ? "neutral"
            : "caution";
  return (
    <Badge tone={tone} dot>
      {status.replace(/_/g, " ")}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

/**
 * A single measured figure.
 *
 * A label, the value, and optionally what the value means. There is no
 * decorative large number here: the value is set for reading in a table of
 * other values, not for filling space.
 */
export function Stat({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
}) {
  const valueTone: Record<Tone, string> = {
    neutral: "text-ink",
    positive: "text-positive",
    caution: "text-caution",
    critical: "text-critical",
    info: "text-info",
  };
  return (
    <div className="min-w-0">
      <dt className="text-2xs font-medium tracking-wide text-ink-subtle uppercase">
        {label}
      </dt>
      <dd className={`mt-0.5 text-xl font-semibold tabular ${valueTone[tone]}`}>
        {value}
      </dd>
      {hint ? <p className="mt-0.5 text-xs text-ink-subtle">{hint}</p> : null}
    </div>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-5 p-4 sm:grid-cols-3 lg:grid-cols-4">
      {children}
    </dl>
  );
}

/** A label and value pair, for dense read-only detail. */
export function Detail({
  label,
  children,
  className = "",
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt className="text-2xs font-medium tracking-wide text-ink-subtle uppercase">
        {label}
      </dt>
      <dd className="mt-0.5 text-sm break-words text-ink">{children}</dd>
    </div>
  );
}

export function DetailList({
  children,
  columns = 2,
}: {
  children: ReactNode;
  columns?: 1 | 2 | 3;
}) {
  const grid =
    columns === 1
      ? "grid-cols-1"
      : columns === 3
        ? "grid-cols-1 sm:grid-cols-3"
        : "grid-cols-1 sm:grid-cols-2";
  return <dl className={`grid gap-x-6 gap-y-4 ${grid}`}>{children}</dl>;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export function Table({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`overflow-x-auto ${className}`}>
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  );
}

export function Th({
  children,
  align = "left",
  className = "",
}: {
  children?: ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={`border-b border-line px-3 py-2 text-2xs font-semibold tracking-wide text-ink-subtle uppercase whitespace-nowrap ${
        align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left"
      } ${className}`}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  align = "left",
  className = "",
  colSpan,
}: {
  children?: ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
  colSpan?: number;
}) {
  return (
    <td
      colSpan={colSpan}
      className={`border-b border-line px-3 py-2 align-middle text-ink ${
        align === "right" ? "text-right tabular" : align === "center" ? "text-center" : "text-left"
      } ${className}`}
    >
      {children}
    </td>
  );
}

export function Tr({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <tr className={className}>{children}</tr>;
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

/**
 * The empty state.
 *
 * Always says what is missing and what to do about it. An empty list with no
 * explanation is a dead end.
 */
export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      {icon ? <div className="mb-3 text-ink-faint">{icon}</div> : null}
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      <div className="mt-1.5 max-w-md text-sm text-ink-muted">{description}</div>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/** The failure state. Always says what failed and what to do next. */
export function ErrorState({
  title = "Something went wrong",
  message,
  nextAction,
  detail,
  onRetry,
}: {
  title?: string;
  message: ReactNode;
  nextAction?: ReactNode;
  detail?: ReactNode;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="rounded-card border border-critical-line bg-critical-soft px-4 py-4"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-critical text-2xs font-bold text-white"
        >
          !
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-critical">{title}</h3>
          <div className="mt-1 text-sm text-ink">{message}</div>
          {nextAction ? (
            <p className="mt-1 text-sm text-ink-muted">{nextAction}</p>
          ) : null}
          {detail ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs font-medium text-ink-muted">
                Technical detail
              </summary>
              <pre className="mt-1.5 overflow-x-auto rounded border border-line bg-surface px-2.5 py-2 text-2xs whitespace-pre-wrap text-ink-muted">
                {detail}
              </pre>
            </details>
          ) : null}
          {onRetry ? (
            <p className="mt-3 text-xs text-ink-muted">
              Reload the page, or use the retry control, to try again.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** A non-blocking notice, for warnings and things worth knowing. */
export function Notice({
  tone = "info",
  title,
  children,
}: {
  tone?: Tone;
  title?: string;
  children: ReactNode;
}) {
  const shell: Record<Tone, string> = {
    neutral: "border-line bg-surface-sunken",
    positive: "border-positive-line bg-positive-soft",
    caution: "border-caution-line bg-caution-soft",
    critical: "border-critical-line bg-critical-soft",
    info: "border-info-line bg-info-soft",
  };
  const heading: Record<Tone, string> = {
    neutral: "text-ink",
    positive: "text-positive",
    caution: "text-caution",
    critical: "text-critical",
    info: "text-info",
  };
  return (
    <div className={`rounded-card border px-3.5 py-3 ${shell[tone]}`}>
      {title ? (
        <p className={`text-sm font-semibold ${heading[tone]}`}>{title}</p>
      ) : null}
      <div className={`text-sm text-ink ${title ? "mt-1" : ""}`}>{children}</div>
    </div>
  );
}

/** Skeleton placeholder for a loading table or panel. */
export function Skeleton({ rows = 4, label }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true">
      {label ? <span className="sr-only">{label}</span> : null}
      <div className="space-y-2 p-4">
        {Array.from({ length: rows }).map((_, index) => (
          <div
            key={index}
            className="h-4 animate-pulse rounded bg-surface-sunken"
            style={{ width: `${100 - index * 7}%` }}
          />
        ))}
      </div>
    </div>
  );
}

/** Inline progress bar with a text equivalent for screen readers. */
export function Progress({
  value,
  label,
}: {
  value: number;
  label: string;
}) {
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs text-ink-muted">
        <span>{label}</span>
        <span className="tabular">{clamped}%</span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
        className="h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken"
      >
        <div
          className="h-full rounded-full bg-info transition-[width] duration-300"
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

/** A link styled as a button, for navigation rather than actions. */
export function ButtonLink({
  children,
  href,
  variant = "secondary",
  size = "md",
  className = "",
}: {
  children: ReactNode;
  href: string;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <a href={href} className={buttonClasses(variant, size, className)}>
      {children}
    </a>
  );
}

export function KeyValue({
  items,
}: {
  items: { label: string; value: ReactNode }[];
}) {
  return (
    <dl className="divide-y divide-line">
      {items.map((item) => (
        <div key={item.label} className="flex gap-4 py-2">
          <dt className="w-44 shrink-0 text-xs text-ink-subtle">{item.label}</dt>
          <dd className="min-w-0 flex-1 text-sm break-words text-ink">
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A horizontal bar, used for feature importance and lift tables. */
export function Bar({
  label,
  value,
  max,
  display,
  tone = "info",
  hint,
}: {
  label: ReactNode;
  value: number;
  max: number;
  display: string;
  tone?: Tone;
  hint?: ReactNode;
}) {
  const width = max > 0 ? Math.max(1, (Math.abs(value) / max) * 100) : 0;
  const fill: Record<Tone, string> = {
    neutral: "bg-ink-faint",
    positive: "bg-positive",
    caution: "bg-caution",
    critical: "bg-critical",
    info: "bg-info",
  };
  return (
    <div className="py-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-sm text-ink">{label}</span>
        <span className="shrink-0 text-xs text-ink-muted tabular">{display}</span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken">
        <div
          className={`h-full rounded-full ${fill[tone]}`}
          style={{ width: `${width}%` }}
        />
      </div>
      {hint ? <p className="mt-0.5 text-xs text-ink-subtle">{hint}</p> : null}
    </div>
  );
}
