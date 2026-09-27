/**
 * Layout for the unauthenticated pages.
 *
 * Deliberately plain: one column, no navigation, nothing that assumes a session.
 */
export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto w-full max-w-5xl px-6 py-4">
          <p className="text-sm font-semibold tracking-tight text-ink">
            Churn Intelligence
          </p>
          <p className="text-xs text-ink-subtle">
            Interpretable prediction and strategic retention
          </p>
        </div>
      </header>
      <main id="main" className="flex flex-1 items-start justify-center px-6 py-12">
        <div className="w-full max-w-sm">{children}</div>
      </main>
      <footer className="border-t border-line px-6 py-4">
        <p className="mx-auto max-w-5xl text-xs text-ink-subtle">
          Access is restricted to authorised users. Every action taken here is
          recorded in the audit trail.
        </p>
      </footer>
    </div>
  );
}
