"use client";

/**
 * Primary navigation.
 *
 * A client component because it highlights the current route. Every link here
 * leads to a page that does real work; there are no placeholder destinations.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

interface NavItem {
  href: string;
  label: string;
  /** Longer description used as the accessible name and tooltip. */
  description: string;
}

const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: "Overview",
    items: [
      {
        href: "/dashboard",
        label: "Dashboard",
        description: "Operational state of the platform",
      },
    ],
  },
  {
    group: "Data",
    items: [
      {
        href: "/datasets",
        label: "Datasets",
        description: "Uploaded churn datasets and their validation",
      },
      {
        href: "/training",
        label: "Training",
        description: "Training runs and their progress",
      },
      {
        href: "/models",
        label: "Models",
        description: "Trained models, performance and activation",
      },
    ],
  },
  {
    group: "Decisions",
    items: [
      {
        href: "/customers",
        label: "Customers",
        description: "Customer risk, explanations and actions",
      },
      {
        href: "/predictions",
        label: "Predictions",
        description: "Every prediction the platform has made",
      },
      {
        href: "/retention",
        label: "Retention",
        description: "Strategies and the actions they produce",
      },
    ],
  },
  {
    group: "Oversight",
    items: [
      {
        href: "/reports",
        label: "Reports",
        description: "Generated reports and their exports",
      },
      {
        href: "/audit",
        label: "Audit trail",
        description: "Who did what, and when",
      },
      {
        href: "/settings",
        label: "Settings",
        description: "Thresholds, model settings and your profile",
      },
    ],
  },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === "/dashboard";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Navigation({ role }: { role: string }) {
  const pathname = usePathname() ?? "";

  return (
    <nav aria-label="Primary" className="flex-1 overflow-y-auto px-3 py-4">
      {NAV.map((section) => (
        <div key={section.group} className="mb-5">
          <h2 className="mb-1.5 px-2 text-2xs font-semibold tracking-wider text-ink-faint uppercase">
            {section.group}
          </h2>
          <ul className="space-y-0.5">
            {section.items.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    title={item.description}
                    aria-current={active ? "page" : undefined}
                    className={`block rounded-control px-2 py-1.5 text-sm transition-colors ${
                      active
                        ? "bg-action-soft font-medium text-action"
                        : "text-ink-muted hover:bg-surface-sunken hover:text-ink"
                    }`}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <p className="mt-6 border-t border-line px-2 pt-3 text-2xs text-ink-faint">
        Signed in as {role}
      </p>
    </nav>
  );
}
