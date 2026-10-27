import { CheckCircle2, ShieldCheck } from "lucide-react";
import { Suspense } from "react";
import { Await, data, Form, Link, useNavigation } from "react-router";
import type { Route } from "./+types/index.ts";
import { CopyButton } from "#app/components/copy-button.tsx";
import { UsageMeters, UsageSkeleton } from "#app/components/usage-meter.tsx";
import { Button } from "#app/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "#app/components/ui/card.tsx";
import { conduitContext } from "#app/context.ts";
import { usageView } from "#app/utils/providers.server.ts";
import { redirectWithToast } from "#app/utils/toast.server.ts";

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `${loaderData?.name ?? "Provider"} · conduit` }];
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function loader({ params, context }: Route.LoaderArgs) {
  const { registry } = context.get(conduitContext);
  const entry = registry.store.get(params.id);
  if (!entry) throw data("No such provider", { status: 404 });
  const command =
    entry.configDir === undefined
      ? "claude /login"
      : `CLAUDE_CONFIG_DIR=${shellQuote(entry.configDir)} claude /login`;
  return {
    id: entry.id,
    name: entry.name,
    enabled: entry.enabled,
    configDir: entry.configDir,
    command,
    usage: usageView(registry, entry.id),
  };
}

export async function action({ params, context }: Route.ActionArgs) {
  const { registry } = context.get(conduitContext);
  const entry = registry.store.get(params.id);
  if (!entry) throw data("No such provider", { status: 404 });
  const result = await registry.verify(entry.id);
  return redirectWithToast(`/providers/${entry.id}`, {
    type: result.ok ? "success" : "error",
    title: result.ok ? "Login verified" : "Not logged in yet",
    description: result.message,
  });
}

export default function ProviderDetail({ loaderData }: Route.ComponentProps) {
  const { id, name, configDir, command, usage } = loaderData;
  const navigation = useNavigation();
  const verifying = navigation.state === "submitting";
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <nav className="text-sm text-muted-foreground" aria-label="Breadcrumb">
        <Link to="/" className="hover:text-foreground">
          Providers
        </Link>{" "}
        / <span className="text-foreground">{name}</span>
      </nav>
      <Card>
        <CardHeader>
          <div className="space-y-1.5">
            <CardTitle className="text-xl">{name}</CardTitle>
            <CardDescription>
              {configDir ? (
                <>
                  Login stored in <code className="font-mono">{configDir}</code>
                </>
              ) : (
                "Uses Claude Code's default login."
              )}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <section className="space-y-2">
            <h2 className="flex items-center gap-2 font-medium">
              <ShieldCheck className="size-4" /> Log in
            </h2>
            <p className="text-sm text-muted-foreground">
              Run this in a terminal and finish signing in. Then verify.
            </p>
            <div className="flex items-center justify-between gap-2 rounded-md border bg-muted px-3 py-2">
              <code className="font-mono text-sm break-all">{command}</code>
              <CopyButton text={command} />
            </div>
            <Form method="post">
              <input type="hidden" name="id" value={id} />
              <Button type="submit" disabled={verifying}>
                <CheckCircle2 />
                {verifying ? "Verifying…" : "Verify login"}
              </Button>
            </Form>
          </section>
          <section className="space-y-3">
            <h2 className="font-medium">Usage</h2>
            <Suspense fallback={<UsageSkeleton />}>
              <Await resolve={usage}>
                {(u) => (
                  <>
                    {u.account ? (
                      <p className="text-sm text-muted-foreground">
                        {[u.account.email, u.account.organization, u.account.plan]
                          .filter(Boolean)
                          .join(" · ") || u.account.auth}
                      </p>
                    ) : null}
                    <UsageMeters usage={u} />
                  </>
                )}
              </Await>
            </Suspense>
          </section>
        </CardContent>
      </Card>
    </div>
  );
}
