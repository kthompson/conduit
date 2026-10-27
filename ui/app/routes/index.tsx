import { Plus } from "lucide-react";
import { data, Link } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/index.ts";
import { ProviderCard } from "#app/components/provider-card.tsx";
import { Button } from "#app/components/ui/button.tsx";
import { conduitContext } from "#app/context.ts";
import { toView, usageView } from "#app/utils/providers.server.ts";
import { redirectWithToast } from "#app/utils/toast.server.ts";

export function meta() {
  return [{ title: "Providers · conduit" }];
}

export function loader({ context }: Route.LoaderArgs) {
  const { registry } = context.get(conduitContext);
  const providers = toView(registry.status());
  // Usage streams in per provider; each read spawns a Claude Code process and is cached for a minute.
  return {
    providers: providers.map((p) => ({ provider: p, usage: usageView(registry, p.id) })),
  };
}

const intentSchema = z.object({
  id: z.string().min(1),
  intent: z.enum(["up", "down", "enable", "disable", "refresh"]),
});

export async function action({ request, context }: Route.ActionArgs) {
  const { registry } = context.get(conduitContext);
  const parsed = intentSchema.safeParse(Object.fromEntries(await request.formData()));
  if (!parsed.success) throw data("Invalid request", { status: 400 });
  const { id, intent } = parsed.data;
  const entry = registry.store.get(id);
  if (!entry) throw data("No such provider", { status: 404 });
  try {
    switch (intent) {
      case "up":
      case "down":
        registry.store.move(id, intent);
        return null;
      case "enable":
      case "disable":
        registry.store.update(id, { enabled: intent === "enable" });
        return await redirectWithToast("/", {
          type: "success",
          title: `${entry.name} ${intent}d`,
        });
      case "refresh":
        await registry.usage(id, { force: true });
        return await redirectWithToast("/", { type: "info", title: `Refreshed ${entry.name}` });
    }
  } catch (error) {
    return redirectWithToast("/", {
      type: "error",
      title: "Could not update provider",
      description: error instanceof Error ? error.message : String(error),
    });
  }
}

export default function Providers({ loaderData }: Route.ComponentProps) {
  const { providers } = loaderData;
  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Providers</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            New conversations go to the first ready provider, top to bottom. If it is rate limited
            or logged out, conduit moves on to the next.
          </p>
        </div>
        <Button asChild>
          <Link to="/providers/new">
            <Plus />
            Add provider
          </Link>
        </Button>
      </div>
      <div className="grid gap-4">
        {providers.map(({ provider, usage }) => (
          <ProviderCard key={provider.id} provider={provider} usage={usage} />
        ))}
      </div>
    </div>
  );
}
