"use client";

/**
 * Form primitives.
 *
 * Labels are bound to their inputs, errors are announced, and required fields
 * say so in text rather than only in colour. A form that cannot be completed
 * with a keyboard or a screen reader is not finished.
 */

import type { ReactNode } from "react";
import { useId } from "react";

export function Field({
  label,
  name,
  type = "text",
  error,
  hint,
  required,
  autoComplete,
  defaultValue,
  placeholder,
  inputMode,
  rows,
  options,
  disabled,
  min,
  max,
  step,
  accept,
  value,
  onChange,
  onFileSelected,
}: {
  label: string;
  name: string;
  type?: string;
  error?: string;
  hint?: ReactNode;
  required?: boolean;
  autoComplete?: string;
  defaultValue?: string | number;
  placeholder?: string;
  inputMode?: "text" | "numeric" | "decimal" | "email" | "tel" | "search";
  rows?: number;
  options?: { value: string; label: string }[];
  disabled?: boolean;
  min?: string | number;
  max?: string | number;
  step?: string | number;
  /** Accepted file types, for a file input. */
  accept?: string;
  /** Makes the input controlled. Provide with onChange. */
  value?: string;
  onChange?: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  /** Notified when a file is chosen, so the field can describe the selection. */
  onFileSelected?: (filename: string | null) => void;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;

  const describedBy =
    [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ") ||
    undefined;

  if (options) {
    return (
      <div>
        <label
          htmlFor={id}
          className="mb-1 block text-xs font-medium text-ink"
        >
          {label}
          {required ? (
            <span className="ml-1 text-critical" aria-hidden="true">
              *
            </span>
          ) : null}
        </label>
        <select
          id={id}
          name={name}
          defaultValue={defaultValue}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={`w-full rounded-control border bg-surface px-2.5 py-1.5 text-sm text-ink disabled:bg-surface-sunken disabled:text-ink-subtle ${
            error ? "border-critical" : "border-line-strong"
          }`}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {error ? <FieldError id={errorId}>{error}</FieldError> : null}
        {hint ? (
          <p id={hintId} className="mt-1 text-xs text-ink-subtle">
            {hint}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-ink">
        {label}
        {required ? (
          <>
            <span className="ml-1 text-critical" aria-hidden="true">
              *
            </span>
            <span className="sr-only"> (required)</span>
          </>
        ) : null}
      </label>
      {type === "textarea" ? (
        <textarea
          id={id}
          name={name}
          rows={rows ?? 4}
          defaultValue={defaultValue === undefined ? undefined : String(defaultValue)}
          placeholder={placeholder}
          disabled={disabled}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={`w-full rounded-control border bg-surface px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-faint disabled:bg-surface-sunken ${
            error ? "border-critical" : "border-line-strong"
          }`}
        />
      ) : (
        <input
          id={id}
          name={name}
          type={type}
          inputMode={inputMode}
          accept={accept}
          autoComplete={autoComplete}
          value={value}
          onChange={(event) => {
            // A file input reports the chosen file so the field can describe
            // the selection; anything else uses the caller's handler.
            if (type === "file") {
              onFileSelected?.(
                (event.target as HTMLInputElement).files?.[0]?.name ?? null,
              );
            }
            onChange?.(event);
          }}
          defaultValue={
            value === undefined && defaultValue !== undefined
              ? String(defaultValue)
              : undefined
          }
          placeholder={placeholder}
          disabled={disabled}
          required={required}
          min={min}
          max={max}
          step={step}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={`w-full rounded-control border bg-surface px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-faint disabled:bg-surface-sunken disabled:text-ink-subtle file:mr-2 file:rounded file:border-0 file:bg-surface-sunken file:px-2 file:py-1 file:text-xs file:text-ink ${
            error ? "border-critical" : "border-line-strong"
          }`}
        />
      )}
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
      {hint ? (
        <p id={hintId} className="mt-1 text-xs text-ink-subtle">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Checkbox({
  label,
  name,
  defaultChecked,
  hint,
  value = "true",
}: {
  label: string;
  name: string;
  defaultChecked?: boolean;
  hint?: ReactNode;
  value?: string;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="flex items-start gap-2">
      <input
        id={id}
        name={name}
        type="checkbox"
        value={value}
        defaultChecked={defaultChecked}
        aria-describedby={hint ? hintId : undefined}
        className="mt-0.5 size-3.5 rounded border-line-strong text-action focus-visible:outline-2"
      />
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm text-ink">
          {label}
        </label>
        {hint ? (
          <p id={hintId} className="text-xs text-ink-subtle">
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function FieldError({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <p id={id} className="mt-1 text-xs text-critical">
      {children}
    </p>
  );
}

/** A form-level message, announced when it appears. */
export function FormAlert({
  tone = "info",
  children,
}: {
  tone?: "info" | "positive" | "caution" | "critical";
  children: ReactNode;
}) {
  const shell: Record<string, string> = {
    info: "border-info-line bg-info-soft text-ink",
    positive: "border-positive-line bg-positive-soft text-ink",
    caution: "border-caution-line bg-caution-soft text-ink",
    critical: "border-critical-line bg-critical-soft text-critical",
  };
  return (
    <div
      role={tone === "critical" ? "alert" : "status"}
      aria-live={tone === "critical" ? "assertive" : "polite"}
      className={`rounded-card border px-3 py-2.5 text-sm ${shell[tone]}`}
    >
      {children}
    </div>
  );
}
