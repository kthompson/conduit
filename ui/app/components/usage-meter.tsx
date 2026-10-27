import { Progress } from "#app/components/ui/progress.tsx";
import { cn } from "#app/utils/cn.ts";
import type { Level, UsageView } from "#app/utils/providers.server.ts";

const bar: Record<Level, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  high: "bg-destructive",
};

export function UsageMeters({ usage }: { usage: UsageView }) {
  return (
    <div className="space-y-3">
      {usage.windows.map((w) => (
        <div key={w.id} className="space-y-1.5">
          <div className="flex items-baseline justify-between text-sm">
            <span>{w.label}</span>
            <span className="text-muted-foreground tabular-nums">
              <span className={cn("font-medium", w.level === "high" && "text-destructive")}>
                {w.percent}%
              </span>
              {w.resetsIn ? ` · resets in ${w.resetsIn}` : ""}
            </span>
          </div>
          <Progress
            value={w.percent}
            className="bg-muted"
            indicatorClassName={bar[w.level]}
            aria-label={w.label}
          />
        </div>
      ))}
      {usage.extraUsage?.enabled ? (
        <p className="text-sm text-muted-foreground">
          Extra usage: {usage.extraUsage.used ?? "n/a"}
          {usage.extraUsage.limit ? ` of ${usage.extraUsage.limit}` : ""} this month
        </p>
      ) : null}
      {usage.windows.length === 0 && !usage.error ? (
        <p className="text-sm text-muted-foreground">
          {usage.account?.billedToApi
            ? "Billed to an API key; plan limits do not apply."
            : "No plan limits reported."}
        </p>
      ) : null}
      {usage.error ? <p className="text-sm text-warning">{usage.error}</p> : null}
    </div>
  );
}

export function UsageSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading usage">
      {[0, 1].map((i) => (
        <div key={i} className="space-y-2">
          <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
          <div className="h-2 animate-pulse rounded-full bg-muted" />
        </div>
      ))}
    </div>
  );
}
