import { Card, Skeleton } from "@/components/ui";

/**
 * Loading state for this section.
 *
 * Names what is loading and reserves the shape of the page, so the layout does
 * not jump when the data arrives.
 */
export default function Loading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      <div className="mb-6">
        <div className="h-6 w-64 animate-pulse rounded bg-surface-sunken" />
        <div className="mt-2 h-4 w-96 max-w-full animate-pulse rounded bg-surface-sunken" />
      </div>
      <Card>
        <Skeleton rows={8} label="Loading data" />
      </Card>
    </div>
  );
}
