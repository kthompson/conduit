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
  /** How the CLI authenticated, in words. */
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

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A usage read that failed before it learned anything about the account. */
export function failedUsage(error: unknown): ProviderUsage {
  return {
    fetchedAt: Date.now(),
    account: undefined,
    windows: [],
    extraUsage: undefined,
    error: errorMessage(error),
  };
}
