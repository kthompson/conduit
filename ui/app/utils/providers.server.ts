import type { ProviderStatus } from "../../../src/providers/registry.ts";
import type { ProviderRegistry } from "../../../src/providers/registry.ts";
import { formatDuration } from "./format.ts";

export type Level = "ok" | "warn" | "high";

export interface UsageView {
  account:
    | {
        email: string | undefined;
        organization: string | undefined;
        plan: string | undefined;
        auth: string;
        billedToApi: boolean;
      }
    | undefined;
  windows: Array<{
    id: string;
    label: string;
    percent: number;
    resetsIn: string | undefined;
    level: Level;
  }>;
  extraUsage: { enabled: boolean; used: string | undefined; limit: string | undefined } | undefined;
  error: string | undefined;
}

export interface ProviderView {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  isDefault: boolean;
  /** 1 is tried first, among providers of the same type. */
  priority: number;
  isLast: boolean;
  configDir: string | undefined;
  health: ProviderStatus["health"];
  detail: string | undefined;
  limitedFor: string | undefined;
  counters: ProviderStatus["counters"];
}

export function toView(statuses: ProviderStatus[]): ProviderView[] {
  const now = Date.now();
  // Priority only matters between logins of one provider type: a Claude login never stands in for Codex.
  const ofType = (type: string) => statuses.filter((s) => s.entry.type === type);
  return statuses.map((s) => ({
    id: s.entry.id,
    name: s.entry.name,
    type: s.entry.type,
    enabled: s.entry.enabled,
    isDefault: s.entry.id === "default",
    priority: ofType(s.entry.type).indexOf(s) + 1,
    isLast: ofType(s.entry.type).at(-1) === s,
    configDir: s.entry.configDir,
    health: s.health,
    detail: s.detail,
    limitedFor: s.limitedUntil === undefined ? undefined : formatDuration(s.limitedUntil - now),
    counters: s.counters,
  }));
}

const level = (percent: number): Level => (percent >= 90 ? "high" : percent >= 70 ? "warn" : "ok");

const money = (cents: number | null, currency: string) =>
  cents === null
    ? undefined
    : new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);

/** Never rejects: a provider whose usage cannot be read shows the reason instead. */
export async function usageView(
  registry: ProviderRegistry,
  id: string,
  options: { force?: boolean } = {},
): Promise<UsageView> {
  try {
    const usage = await registry.usage(id, options);
    const now = Date.now();
    return {
      account: usage.account,
      windows: usage.windows.map((w) => ({
        id: w.id,
        label: w.label,
        percent: Math.round(w.percent),
        resetsIn: w.resetsAt === null ? undefined : formatDuration(Date.parse(w.resetsAt) - now),
        level: level(w.percent),
      })),
      extraUsage: usage.extraUsage && {
        enabled: usage.extraUsage.enabled,
        used: money(usage.extraUsage.usedCredits, usage.extraUsage.currency),
        limit: money(usage.extraUsage.limit, usage.extraUsage.currency),
      },
      error: usage.error,
    };
  } catch (error) {
    return {
      account: undefined,
      windows: [],
      extraUsage: undefined,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
