import type { TurnFailure } from "./types.ts";

/**
 * Decides whether a failed turn says the provider is rate limited or logged
 * out. `code` is whatever machine-readable reason the provider gave (already
 * normalized to "rate_limit" or one of `authCodes` where it could be); the
 * message is matched as a fallback because both CLIs also report these as prose.
 */
export function classifyFailure(
  code: string | undefined,
  message: string,
  options: { resetsAt?: number | undefined; authCodes?: ReadonlySet<string> } = {},
): TurnFailure | undefined {
  if (code === "rate_limit" || /rate.?limit|usage limit|limit reached|\b429\b/i.test(message)) {
    return {
      kind: "rate_limit",
      ...(options.resetsAt === undefined ? {} : { resetsAt: options.resetsAt }),
    };
  }
  if (
    (code !== undefined && options.authCodes?.has(code)) ||
    /not logged in|\/login|authenticat|invalid api key|unauthorized|\b401\b|credentials/i.test(
      message,
    )
  ) {
    return { kind: "auth" };
  }
  return undefined;
}
