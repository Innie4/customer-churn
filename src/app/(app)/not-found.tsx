import Link from "next/link";

/** Shown for any address that does not match a route. */
export default function NotFound() {
  return (
    <div className="py-12 text-center">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">
        That page does not exist
      </h1>
      <p className="mx-auto mt-2 max-w-md text-sm text-ink-muted">
        The address may be mistyped, or the record it pointed at may have been
        removed.
      </p>
      <p className="mt-6 text-sm">
        <Link
          href="/dashboard"
          className="text-action underline underline-offset-2 hover:text-action-hover"
        >
          Back to the dashboard
        </Link>
      </p>
    </div>
  );
}
