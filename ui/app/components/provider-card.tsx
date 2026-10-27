import { ArrowDown, ArrowUp, Power, RefreshCw, Trash2 } from "lucide-react";
import { Suspense } from "react";
import { Await, Form, Link } from "react-router";
import { UsageMeters, UsageSkeleton } from "#app/components/usage-meter.tsx";
import { Badge } from "#app/components/ui/badge.tsx";
import { Button } from "#app/components/ui/button.tsx";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "#app/components/ui/card.tsx";
import type { ProviderView, UsageView } from "#app/utils/providers.server.ts";
import { formatTokens } from "#app/utils/format.ts";

const health = {
  ready: { label: "Ready", variant: "success" },
  rate_limited: { label: "Rate limited", variant: "warning" },
  auth_failed: { label: "Needs login", variant: "destructive" },
  disabled: { label: "Disabled", variant: "secondary" },
} as const;

export function ProviderCard({
  provider,
  usage,
}: {
  provider: ProviderView;
  usage: Promise<UsageView>;
}) {
  const state = health[provider.health];
  return (
    <Card className={provider.enabled ? "" : "opacity-70"}>
      <CardHeader>
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex size-6 items-center justify-center rounded-full bg-secondary text-xs font-semibold tabular-nums">
              {provider.priority}
            </span>
            <CardTitle>
              <Link to={`/providers/${provider.id}`} className="hover:underline">
                {provider.name}
              </Link>
            </CardTitle>
            <Badge variant="outline" className="capitalize">
              {provider.type}
            </Badge>
            <Badge variant={state.variant}>{state.label}</Badge>
          </div>
          <Suspense fallback={<p className="h-4 w-48 animate-pulse rounded bg-muted" />}>
            <Await resolve={usage}>
              {(u) => (
                <p className="text-sm text-muted-foreground">
                  {u.account
                    ? [u.account.email ?? u.account.organization, u.account.plan]
                        .filter(Boolean)
                        .join(" · ") || u.account.auth
                    : "Account unknown"}
                </p>
              )}
            </Await>
          </Suspense>
          {provider.limitedFor ? (
            <p className="text-sm text-warning">Skipped for another {provider.limitedFor}.</p>
          ) : null}
          {provider.health === "auth_failed" ? (
            <p className="text-sm text-destructive">
              {provider.detail ?? "Login failed."}{" "}
              <Link to={`/providers/${provider.id}`} className="underline">
                Log in again
              </Link>
            </p>
          ) : null}
        </div>
        <Form method="post" className="flex shrink-0 gap-1">
          <input type="hidden" name="id" value={provider.id} />
          <Button
            type="submit"
            name="intent"
            value="up"
            variant="ghost"
            size="icon-sm"
            disabled={provider.priority === 1}
            aria-label={`Raise priority of ${provider.name}`}
            title="Higher priority"
          >
            <ArrowUp />
          </Button>
          <Button
            type="submit"
            name="intent"
            value="down"
            variant="ghost"
            size="icon-sm"
            disabled={provider.isLast}
            aria-label={`Lower priority of ${provider.name}`}
            title="Lower priority"
          >
            <ArrowDown />
          </Button>
        </Form>
      </CardHeader>
      <CardContent>
        <Suspense fallback={<UsageSkeleton />}>
          <Await resolve={usage}>{(u) => <UsageMeters usage={u} />}</Await>
        </Suspense>
      </CardContent>
      <CardContent className="text-sm text-muted-foreground tabular-nums">
        This session: {provider.counters.requests} request
        {provider.counters.requests === 1 ? "" : "s"}
        {" · "}
        {formatTokens(provider.counters.inputTokens)} in (
        {formatTokens(provider.counters.cachedTokens)} cached) /{" "}
        {formatTokens(provider.counters.outputTokens)} out
        {provider.counters.errors > 0 ? ` · ${provider.counters.errors} failed` : ""}
      </CardContent>
      <CardFooter className="flex-wrap">
        <Form method="post" className="flex flex-wrap gap-2">
          <input type="hidden" name="id" value={provider.id} />
          <Button
            type="submit"
            name="intent"
            value={provider.enabled ? "disable" : "enable"}
            variant="outline"
            size="sm"
          >
            <Power />
            {provider.enabled ? "Disable" : "Enable"}
          </Button>
          <Button type="submit" name="intent" value="refresh" variant="outline" size="sm">
            <RefreshCw />
            Refresh usage
          </Button>
        </Form>
        {provider.isDefault ? null : (
          <Button asChild variant="ghost" size="sm" className="ml-auto text-destructive">
            <Link to={`/providers/${provider.id}/delete`}>
              <Trash2 />
              Remove
            </Link>
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}
