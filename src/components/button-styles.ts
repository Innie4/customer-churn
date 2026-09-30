/**
 * Button styling.
 *
 * These live apart from the button components on purpose.
 *
 * `interactive.tsx` is a client module, because the components there accept
 * event handlers. A server component may *render* a client component, but it
 * may not *call* a function exported from one: the module has already been
 * replaced by a client reference, so calling it throws
 *
 *   Attempted to call buttonClasses() from the server but buttonClasses is on
 *   the client.
 *
 * That error is raised while the page is streaming, so the response status has
 * already been sent as 200 and the failure reaches the visitor as the error
 * boundary instead of as a server error. Which makes it look like a data
 * problem rather than a rendering one.
 *
 * `buttonClasses` is a pure function that returns a class name, with no state
 * and no handlers, so it does not need to be a client module at all. Keeping it
 * here lets both the server-side presentational components and the
 * client-side interactive ones share one definition.
 */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

export const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-action text-white hover:bg-action-hover border border-transparent disabled:bg-ink-faint",
  secondary:
    "bg-surface text-ink border border-line-strong hover:bg-surface-sunken disabled:text-ink-faint",
  ghost:
    "bg-transparent text-ink-muted border border-transparent hover:bg-surface-sunken hover:text-ink",
  danger:
    "bg-critical text-white hover:brightness-110 border border-transparent disabled:bg-ink-faint",
};

export const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "px-2.5 py-1 text-xs gap-1.5",
  md: "px-3 py-1.5 text-sm gap-2",
};

/** The class list for a button, given its variant, size and extra classes. */
export function buttonClasses(
  variant: ButtonVariant = "secondary",
  size: ButtonSize = "md",
  className = "",
): string {
  return `inline-flex items-center justify-center rounded-control font-medium transition-colors disabled:cursor-not-allowed ${BUTTON_VARIANTS[variant]} ${BUTTON_SIZES[size]} ${className}`;
}
