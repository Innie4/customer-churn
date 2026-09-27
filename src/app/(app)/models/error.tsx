"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/ui";
import { Button } from "@/components/interactive";
import { newRequestId } from "@/lib/api-client";

/**
 * Error boundary for this section.
 *
 * Shows what failed and offers a retry. The user-facing message never contains a
 * stack trace, a query or a configuration value; the digest is for the logs.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const digest = error.digest ?? newRequestId();

  useEffect(() => {
    // Recorded in the browser console so an operator can correlate the digest
    // with the server log when reporting a problem.
    console.error([], error);
  }, [error, digest]);

  return (
    <div className="py-6">
      <ErrorState
        title="This page could not be loaded"
        message="Something went wrong while fetching the data. The details are in the server log."
        nextAction="Try again. If it keeps failing, the problem is likely with the database or the machine learning service rather than this page."
        detail={`Reference: ${digest}`}
      />
      <div className="mt-4">
        <Button variant="primary" onClick={reset}>
          Try again
        </Button>
      </div>
    </div>
  );
}
