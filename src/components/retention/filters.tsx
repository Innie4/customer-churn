"use client";

/** Retention list filters, driven by the URL so the server does the work. */

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useTransition } from "react";

const STATUSES = [
  { value: "all", label: "All" },
  { value: "suggested", label: "Suggested" },
  { value: "planned", label: "Planned" },
  { value: "in_progress", label: "In progress" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
];

const PRIORITIES = [
  { value: "all", label: "Any priority" },
  { value: "critical", label: "Critical" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

export function RetentionFilters({
  status,
  priority,
}: {
  status: string;
  priority: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const apply = (changes: Record<string, string>) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value && value !== "all") next.set(key, value);
      else next.delete(key);
    }
    next.delete("page");
    startTransition(() => router.push(`${pathname}?${next.toString()}`));
  };

  return (
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <div>
        <label htmlFor="retention-status" className="mb-1 block text-xs font-medium text-ink">
          Status
        </label>
        <select
          id="retention-status"
          value={status}
          onChange={(event) => apply({ status: event.target.value })}
          className="rounded-control border border-line-strong bg-surface px-2 py-1.5 text-sm text-ink"
        >
          {STATUSES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="retention-priority" className="mb-1 block text-xs font-medium text-ink">
          Priority
        </label>
        <select
          id="retention-priority"
          value={priority}
          onChange={(event) => apply({ priority: event.target.value })}
          className="rounded-control border border-line-strong bg-surface px-2 py-1.5 text-sm text-ink"
        >
          {PRIORITIES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <span aria-live="polite" className="pb-1.5 text-xs text-ink-subtle">
        {pending ? "Updating…" : ""}
      </span>
    </div>
  );
}
