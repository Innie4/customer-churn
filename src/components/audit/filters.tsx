"use client";

/** Audit trail filters. */

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/interactive";

export function AuditFilters({
  action,
  outcome,
  search,
  actions,
}: {
  action: string;
  outcome: string;
  search: string;
  actions: string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [term, setTerm] = useState(search);

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
    <form
      className="mb-4 flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        apply({ search: term });
      }}
    >
      <div className="min-w-48 flex-1">
        <label htmlFor="audit-search" className="mb-1 block text-xs font-medium text-ink">
          Search
        </label>
        <input
          id="audit-search"
          type="search"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder="Action, actor or resource id"
          className="w-full rounded-control border border-line-strong bg-surface px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-faint"
        />
      </div>

      <div>
        <label htmlFor="audit-action" className="mb-1 block text-xs font-medium text-ink">
          Action
        </label>
        <select
          id="audit-action"
          value={action}
          onChange={(event) => apply({ action: event.target.value })}
          className="rounded-control border border-line-strong bg-surface px-2 py-1.5 text-sm text-ink"
        >
          <option value="all">All actions</option>
          {actions.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="audit-outcome" className="mb-1 block text-xs font-medium text-ink">
          Outcome
        </label>
        <select
          id="audit-outcome"
          value={outcome}
          onChange={(event) => apply({ outcome: event.target.value })}
          className="rounded-control border border-line-strong bg-surface px-2 py-1.5 text-sm text-ink"
        >
          <option value="all">Any outcome</option>
          <option value="success">Success</option>
          <option value="failure">Failure</option>
          <option value="denied">Denied</option>
        </select>
      </div>

      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? "Applying…" : "Search"}
      </Button>

      {search || action !== "all" || outcome !== "all" ? (
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setTerm("");
            startTransition(() => router.push(pathname));
          }}
        >
          Clear
        </Button>
      ) : null}

      <span aria-live="polite" className="sr-only">
        {pending ? "Updating results" : ""}
      </span>
    </form>
  );
}
