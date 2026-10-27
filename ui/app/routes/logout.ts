import { redirect } from "react-router";
import type { Route } from "./+types/logout.ts";
import { signOut } from "#app/utils/security.server.ts";

// Signing out is a POST (a GET link could be triggered cross-site); the header link posts via a form.
export async function action(_args: Route.ActionArgs) {
  return redirect("/login", { headers: { "set-cookie": await signOut() } });
}

export function loader() {
  return redirect("/");
}
