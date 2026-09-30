/**
 * Route protection.
 *
 * Runs before any protected route renders. It performs a cheap check of the
 * session cookie's shape and expiry claim, and redirects when there is nothing
 * usable. It deliberately does not query the database: a full authorisation
 * check happens in the data access layer on every read and write, so a mistake
 * here cannot expose data.
 *
 * The cookie is signed and carries an expiry the server issued. Verifying that
 * here avoids a pointless render for a request that is certainly signed out.
 */

import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, SESSION_TTL_COOKIE } from "@/lib/auth/constants";

/** Routes reachable without a session. */
const PUBLIC_ROUTES = new Set([
  "/login",
  "/forgot-password",
  "/reset-password",
  "/api/health",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/session",
  "/api/auth/forgot-password",
  "/api/auth/reset-password",
  /*
   * Signs in as a demo account without a password, so the request necessarily
   * arrives with no session. It is reached only when the deployment is a demo,
   * and the route itself refuses otherwise; see `src/lib/demo-accounts.ts`.
   */
  "/api/auth/demo-sign-in",
]);

/** Paths that must never be cached by a shared cache. */
const PRIVATE_PREFIXES = ["/dashboard", "/datasets", "/training", "/models", "/customers", "/predictions", "/retention", "/reports", "/settings", "/audit", "/api"];

function isPublic(pathname: string): boolean {
  if (PUBLIC_ROUTES.has(pathname)) return true;
  // A static asset or a Next.js internal path is not a protected route.
  if (
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico" ||
    pathname === "/robots.txt" ||
    pathname === "/sitemap.xml"
  ) {
    return true;
  }
  return false;
}

/** True when the cookie is absent, unsealed, or past its stated expiry. */
function cookieLooksValid(request: NextRequest): boolean {
  const session = request.cookies.get(SESSION_COOKIE)?.value;
  if (!session) return false;

  const separator = session.lastIndexOf(".");
  if (separator <= 0) return false;

  const ttl = request.cookies.get(SESSION_TTL_COOKIE)?.value;
  if (ttl) {
    const expiry = Number(ttl);
    if (Number.isFinite(expiry) && expiry <= Date.now()) return false;
  }
  return true;
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (isPublic(pathname)) {
    // A signed-in visitor has no reason to see the sign-in form.
    if (
      (pathname === "/login" || pathname === "/forgot-password") &&
      cookieLooksValid(request)
    ) {
      return NextResponse.redirect(new URL("/dashboard", request.url));
    }
    return NextResponse.next();
  }

  if (cookieLooksValid(request)) {
    return NextResponse.next();
  }

  // An API caller gets a machine-readable answer rather than a redirect to an
  // HTML page, so a client can tell "sign in" from "server error".
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      {
        error: {
          code: "unauthorized",
          message: "Your session has ended or was never established.",
          nextAction: "Sign in and try again.",
        },
      },
      { status: 401 },
    );
  }

  const signIn = new URL("/login", request.url);
  // Remember where the visitor was going, so sign-in can return them there.
  if (pathname !== "/") signIn.searchParams.set("next", `${pathname}${search}`);

  const response = NextResponse.redirect(signIn);
  // A redirect response must not be cached with the private headers applied to
  // the pages themselves.
  response.headers.delete("Cache-Control");
  return response;
}

export const config = {
  matcher: [
    /*
     * Everything except Next.js internals and image optimisation. The negative
     * lookahead keeps static files out of the proxy entirely, so it cannot
     * accidentally block a stylesheet or a font.
     */
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};

export { PRIVATE_PREFIXES };
