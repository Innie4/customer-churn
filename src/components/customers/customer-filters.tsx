"use client";

/**
 * Customer list filters.
 *
 * Filtering happens on the server, so the controls drive the URL rather than
 * filtering an in-memory array. That keeps the list correct for a customer base
 * far larger than a browser should hold.
 */

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/interactive";

export function CustomerFilters({
  search,
  risk,
  datasetId,
  sort,
  datasets,
}: {
  search: string;
  risk: string;
  datasetId: string;
  sort: string;
  datasets: { id: string; name: string }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [term, setTerm] = useState(search);

  const apply = (changes: Record<string, string>) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    // Any filter change resets pagination, or page 3 of a longer result set
    // would silently show a different slice.
    next.delete("page");
    startTransition(() => {
      router.push(`${pathname}?${next.toString()}`);
    });
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
        <label htmlFor="customer-search" className="mb-1 block text-xs font-medium text-ink">
          Search
        </label>
        <input
          id="customer-search"
          type="search"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder="Customer identifier or name"
          className="w-full rounded-control border border-line-strong bg-surface px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-faint"
        />
      </div>

      <div>
        <label htmlFor="customer-risk" className="mb-1 block text-xs font-medium text-ink">
          Risk
        </label>
        <select
          id="customer-risk"
          value={risk}
          onChange={(event) => apply({ risk: event.target.value })}
          className="rounded-control border border-line-strong bg-surface px-2 py-1.5 text-sm text-ink"
        >
          <option value="all">All</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
          <option value="unscored">Not yet scored</option>
        </select>
      </div>

      {datasets.length > 0 ? (
        <div>
          <label htmlFor="customer-dataset" className="mb-1 block text-xs font-medium text-ink">
            Dataset
          </label>
          <select
            id="customer-dataset"
            value={datasetId}
            onChange={(event) => apply({ dataset: event.target.value })}
            className="rounded-control border border-line-strong bg-surface px-2 py-1.5 text-sm text-ink"
          >
            <option value="">All datasets</option>
            {datasets.map((dataset) => (
              <option key={dataset.id} value={dataset.id}>
                {dataset.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div>
        <label htmlFor="customer-sort" className="mb-1 block text-xs font-medium text-ink">
          Sort
        </label>
        <select
          id="customer-sort"
          value={sort}
          onChange={(event) => apply({ sort: event.target.value })}
          className="rounded-control border border-line-strong bg-surface px-2 py-1.5 text-sm text-ink"
        >
          <option value="risk">Risk</option>
          <option value="probability">Churn probability</option>
          <option value="name">Customer</option>
          <option value="recent">Recently scored</option>
        </select>
      </div>

      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? "Applying…" : "Search"}
      </Button>

      {search || risk !== "all" || datasetId ? (
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
