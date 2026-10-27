import { randomBytes } from "node:crypto";
import { createCookieSessionStorage, redirect } from "react-router";

export type ToastType = "success" | "error" | "info";
export interface Toast {
  type: ToastType;
  title: string;
  description?: string;
}

// Flash messages only need to survive one redirect, so a per-process secret is enough.
const storage = createCookieSessionStorage<Record<string, never>, { toast: Toast }>({
  cookie: {
    name: "conduit_flash",
    path: "/ui",
    httpOnly: true,
    sameSite: "lax",
    secrets: [randomBytes(32).toString("hex")],
  },
});

export async function redirectWithToast(url: string, toast: Toast, init?: ResponseInit) {
  const session = await storage.getSession();
  session.flash("toast", toast);
  const headers = new Headers(init?.headers);
  headers.append("set-cookie", await storage.commitSession(session));
  return redirect(url, { ...init, headers });
}

/** Reads and clears the pending toast; merge `headers` into the response. */
export async function takeToast(request: Request) {
  const session = await storage.getSession(request.headers.get("cookie"));
  const toast = session.get("toast") ?? null;
  const headers = new Headers();
  if (toast) headers.append("set-cookie", await storage.commitSession(session));
  return { toast, headers };
}
