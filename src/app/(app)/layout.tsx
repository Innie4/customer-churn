import { redirect } from "next/navigation";
import { Navigation } from "@/components/navigation";
import { SignOutButton } from "@/components/sign-out-button";
import { getSession } from "@/lib/auth/session";
import { ROLE_LABELS } from "@/lib/dal/access";

/**
 * The authenticated shell.
 *
 * Resolves the session once, on the server. A missing session redirects to
 * sign-in here as well as in the proxy, because this is the last point before
 * any protected content is composed.
 */
export default async function AppLayout({ children }: LayoutProps<"/">) {
  const session = await getSession();
  if (!session) redirect("/login");

  return (
    <div className="flex min-h-screen bg-canvas">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-line bg-surface lg:flex">
        <div className="border-b border-line px-4 py-4">
          <p className="text-sm font-semibold tracking-tight text-ink">
            Churn Intelligence
          </p>
          <p className="text-2xs text-ink-subtle">
            {ROLE_LABELS[session.role]}
          </p>
        </div>
        <Navigation role={session.role} />
        <SignOutButton email={session.email} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Compact header for narrow screens, where the sidebar is hidden. */}
        <header className="flex items-center justify-between border-b border-line bg-surface px-4 py-3 lg:hidden">
          <p className="text-sm font-semibold text-ink">Churn Intelligence</p>
          <span className="truncate text-2xs text-ink-subtle">{session.email}</span>
        </header>
        <main id="main" className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto w-full max-w-7xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
