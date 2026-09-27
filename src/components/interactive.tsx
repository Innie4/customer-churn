"use client";

/**
 * Interactive primitives.
 *
 * Separated from the rest of the design system because these accept event
 * handlers, which makes them client components. Everything purely presentational
 * stays on the server.
 */

import type { ReactNode } from "react";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

export const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-action text-white hover:bg-action-hover border border-transparent disabled:bg-ink-faint",
  secondary:
    "bg-surface text-ink border border-line-strong hover:bg-surface-sunken disabled:text-ink-faint",
  ghost:
    "bg-transparent text-ink-muted border border-transparent hover:bg-surface-sunken hover:text-ink",
  danger:
    "bg-critical text-white hover:brightness-110 border border-transparent disabled:bg-ink-faint",
};

export const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "px-2.5 py-1 text-xs gap-1.5",
  md: "px-3 py-1.5 text-sm gap-2",
};

export function buttonClasses(
  variant: ButtonVariant = "secondary",
  size: ButtonSize = "md",
  className = "",
): string {
  return `inline-flex items-center justify-center rounded-control font-medium transition-colors disabled:cursor-not-allowed ${BUTTON_VARIANTS[variant]} ${BUTTON_SIZES[size]} ${className}`;
}

export function Button({
  children,
  variant = "secondary",
  size = "md",
  className = "",
  type = "button",
  ...rest
}: {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={buttonClasses(variant, size, className)}
      {...rest}
    >
      {children}
    </button>
  );
}

/**
 * The retryable failure state.
 *
 * A failure the user cannot act on is a dead end, so retry is offered whenever
 * retrying could plausibly help.
 */
export function RetryableError({
  title = "Something went wrong",
  message,
  nextAction,
  detail,
  onRetry,
  retryLabel = "Try again",
  retrying = false,
}: {
  title?: string;
  message: ReactNode;
  nextAction?: ReactNode;
  detail?: ReactNode;
  onRetry: () => void;
  retryLabel?: string;
  retrying?: boolean;
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
          <div className="mt-3">
            <Button
              variant="secondary"
              size="sm"
              onClick={onRetry}
              disabled={retrying}
            >
              {retrying ? "Retrying…" : retryLabel}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
