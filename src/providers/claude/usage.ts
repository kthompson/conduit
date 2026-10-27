import type { ClaudeConfig } from "../../config.ts";
import { openProbe } from "./probe.ts";

export interface UsageWindow {
  id: string;
  label: string;
  /** Share of the window used, 0-100. */
  percent: number;
  resetsAt: string | null;
}

export interface ProviderAccount {
  email: string | undefined;
  organization: string | undefined;
  /** "pro", "max", "team", ... */
  plan: string | undefined;
  /** How Claude Code authenticated, in words. */
  auth: string;
  /** True when requests bill an API key instead of a subscription. */
  billedToApi: boolean;
}

export interface ProviderUsage {
  fetchedAt: number;
  account: ProviderAccount | undefined;
  windows: UsageWindow[];
  extraUsage:
    | { enabled: boolean; usedCredits: number | null; limit: number | null; currency: string }
    | undefined;
  /** Why account or usage could not be read, if it could not. */
  error: string | undefined;
}

export type UsageSource = (config: ClaudeConfig) => Promise<ProviderUsage>;

/** Asks a short-lived Claude Code process who is logged in and how much of the plan is used. */
export const fetchClaudeUsage: UsageSource = async (config) => {
  const q = openProbe(config, { keepOpen: true });
  try {
    const info = await q.accountInfo();
    const usesKey = info.apiKeySource !== undefined && info.apiKeySource !== "none";
    const account: ProviderAccount = {
      email: info.email,
      organization: info.organization,
      plan: info.subscriptionType,
      auth: usesKey
        ? `API key (${info.apiKeySource})`
        : info.subscriptionType
          ? "Subscription login"
          : `Login (${info.tokenSource ?? "unknown source"})`,
      billedToApi: usesKey,
    };
    const result: ProviderUsage = {
      fetchedAt: Date.now(),
      account,
      windows: [],
      extraUsage: undefined,
      error: undefined,
    };
    try {
      // Experimental SDK call; plan limits are a nice-to-have, so failures only drop the meters.
      const usage = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
        skipBehaviors: true,
      });
      const limits = usage.rate_limits;
      if (limits) {
        const add = (
          id: string,
          label: string,
          w: { utilization: number | null; resets_at: string | null } | null | undefined,
        ) => {
          if (w && w.utilization !== null) {
            result.windows.push({ id, label, percent: w.utilization, resetsAt: w.resets_at });
          }
        };
        add("five_hour", "5-hour session", limits.five_hour);
        add("seven_day", "Weekly (all models)", limits.seven_day);
        add("seven_day_opus", "Weekly (Opus)", limits.seven_day_opus);
        add("seven_day_sonnet", "Weekly (Sonnet)", limits.seven_day_sonnet);
        for (const m of limits.model_scoped ?? []) {
          add(`model:${m.display_name}`, `Weekly (${m.display_name})`, m);
        }
        const extra = limits.extra_usage;
        if (extra) {
          result.extraUsage = {
            enabled: extra.is_enabled,
            usedCredits: extra.used_credits,
            limit: extra.monthly_limit,
            currency: extra.currency ?? "USD",
          };
        }
      }
    } catch (error) {
      result.error = `Plan limits unavailable: ${errorMessage(error)}`;
    }
    return result;
  } catch (error) {
    return {
      fetchedAt: Date.now(),
      account: undefined,
      windows: [],
      extraUsage: undefined,
      error: errorMessage(error),
    };
  } finally {
    q.close();
  }
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
