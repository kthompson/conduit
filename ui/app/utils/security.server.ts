import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createCookie, data } from "react-router";

const authCookie = createCookie("conduit_auth", {
  path: "/ui",
  httpOnly: true,
  sameSite: "lax",
  maxAge: 60 * 60 * 24 * 30,
});

function tokenFor(apiKey: string): string {
  return createHmac("sha256", apiKey).update("conduit-ui-session").digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function isAuthenticated(request: Request, apiKey: string | undefined) {
  if (apiKey === undefined) return true;
  const value: unknown = await authCookie.parse(request.headers.get("cookie"));
  return typeof value === "string" && safeEqual(value, tokenFor(apiKey));
}

export function keyMatches(given: string, apiKey: string): boolean {
  return safeEqual(tokenFor(given), tokenFor(apiKey));
}

export function signIn(apiKey: string, secure: boolean): Promise<string> {
  return authCookie.serialize(tokenFor(apiKey), { secure });
}

export function signOut(): Promise<string> {
  return authCookie.serialize("", { maxAge: 0 });
}

/**
 * Cookies are SameSite=Lax and every mutation is a POST, so cross-site forms
 * cannot ride the session. Checking Origin as well stops a hostile page from
 * posting to a UI that has no api_key set.
 */
export function assertSameOrigin(request: Request) {
  if (request.method === "GET" || request.method === "HEAD") return;
  const origin = request.headers.get("origin");
  if (origin === null) return;
  const host = request.headers.get("host");
  if (host === null || new URL(origin).host !== host) {
    throw data("Cross-origin request blocked", { status: 403 });
  }
}

export function newNonce(): string {
  return randomBytes(16).toString("base64");
}

export function securityHeaders(nonce: string, options: { dev: boolean; reportOnly: boolean }) {
  const headers = new Headers({
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin",
  });
  // The Vite dev server injects inline scripts and a websocket for HMR.
  if (!options.dev) {
    const policy = [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}'`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; ");
    headers.set(
      options.reportOnly ? "content-security-policy-report-only" : "content-security-policy",
      policy,
    );
  }
  return headers;
}
