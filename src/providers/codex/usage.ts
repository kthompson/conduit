import type { CodexConfig } from "../../config.ts";
import {
  failedUsage,
  type ProviderAccount,
  type ProviderUsage,
  type UsageWindow,
} from "../usage.ts";
import { queryCodex } from "./appServer.ts";

interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

interface RateLimitSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
}

interface AccountResponse {
  account: { type: string; email?: string | null; planType?: string } | null;
}

interface RateLimitsResponse {
  rateLimits: RateLimitSnapshot;
  rateLimitsByLimitId: Record<string, RateLimitSnapshot | undefined> | null;
}

/** "5-hour session", "Weekly", "Monthly" for the window lengths Codex uses; minutes otherwise. */
export function windowLabel(minutes: number | null): string {
  if (minutes === null) return "Usage";
  if (minutes === 300) return "5-hour session";
  if (minutes === 10_080) return "Weekly";
  if (minutes >= 43_200 && minutes <= 44_640) return "Monthly";
  if (minutes % 1_440 === 0) return `${minutes / 1_440}-day window`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour window`;
  return `${minutes}-minute window`;
}

function windowsOf(response: RateLimitsResponse): UsageWindow[] {
  const snapshots = response.rateLimitsByLimitId
    ? Object.values(response.rateLimitsByLimitId).filter((s) => s !== undefined)
    : [response.rateLimits];
  const out: UsageWindow[] = [];
  for (const snapshot of snapshots) {
    const scope = snapshot.limitName ?? snapshot.limitId;
    const main = snapshot.limitId === null || snapshot.limitId === "codex";
    for (const slot of ["primary", "secondary"] as const) {
      const w = snapshot[slot];
      if (!w) continue;
      const label = windowLabel(w.windowDurationMins);
      out.push({
        id: `${snapshot.limitId ?? "codex"}:${slot}`,
        label: main || scope === null ? label : `${label} (${scope})`,
        percent: w.usedPercent,
        // Codex reports epoch seconds.
        resetsAt: w.resetsAt === null ? null : new Date(w.resetsAt * 1000).toISOString(),
      });
    }
  }
  return out;
}

/** Asks a short-lived Codex process who is logged in and how much of the plan is used. */
export async function fetchCodexUsage(config: CodexConfig): Promise<ProviderUsage> {
  try {
    return await queryCodex(config, async (client) => {
      const { account } = await client.request<AccountResponse>("account/read", {
        refreshToken: false,
      });
      if (!account) return failedUsage("Codex is not logged in. Run `codex login`.");
      const apiKey = account.type === "apiKey";
      const view: ProviderAccount = {
        email: account.email ?? undefined,
        organization: undefined,
        plan: account.planType,
        auth: apiKey
          ? "API key"
          : account.planType
            ? `ChatGPT login (${account.planType})`
            : "ChatGPT login",
        billedToApi: apiKey,
      };
      const result: ProviderUsage = {
        fetchedAt: Date.now(),
        account: view,
        windows: [],
        extraUsage: undefined,
        error: undefined,
      };
      try {
        result.windows = windowsOf(
          await client.request<RateLimitsResponse>("account/rateLimits/read"),
        );
      } catch (error) {
        // Plan limits are a nice-to-have, so a failure only drops the meters.
        result.error = `Plan limits unavailable: ${error instanceof Error ? error.message : String(error)}`;
      }
      return result;
    });
  } catch (error) {
    return failedUsage(error);
  }
}
