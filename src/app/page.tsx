import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";

/**
 * The root route.
 *
 * There is no landing page. The application either has a session and opens on
 * the dashboard, or it does not and asks for sign-in.
 */
export default async function RootPage() {
  const session = await getSession();
  redirect(session ? "/dashboard" : "/login");
}
