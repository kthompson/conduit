import { Link } from "react-router";
import { data, Form } from "react-router";
import type { Route } from "./+types/delete.ts";
import { Button } from "#app/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "#app/components/ui/card.tsx";
import { conduitContext } from "#app/context.ts";
import { redirectWithToast } from "#app/utils/toast.server.ts";

export function meta() {
  return [{ title: "Remove provider · conduit" }];
}

export function loader({ params, context }: Route.LoaderArgs) {
  const { registry } = context.get(conduitContext);
  const entry = registry.store.get(params.id);
  if (!entry) throw data("No such provider", { status: 404 });
  if (entry.id === "default") throw data("The default provider cannot be removed", { status: 400 });
  return { id: entry.id, name: entry.name, configDir: entry.configDir };
}

export async function action({ params, context }: Route.ActionArgs) {
  const { registry } = context.get(conduitContext);
  try {
    const removed = registry.store.remove(params.id);
    return await redirectWithToast("/", { type: "success", title: `Removed ${removed.name}` });
  } catch (error) {
    return redirectWithToast("/", {
      type: "error",
      title: "Could not remove provider",
      description: error instanceof Error ? error.message : String(error),
    });
  }
}

export default function DeleteProvider({ loaderData }: Route.ComponentProps) {
  const { id, name, configDir } = loaderData;
  return (
    <div className="mx-auto max-w-xl space-y-6">
      <nav className="text-sm text-muted-foreground" aria-label="Breadcrumb">
        <Link to="/" className="hover:text-foreground">
          Providers
        </Link>{" "}
        /{" "}
        <Link to={`/providers/${id}`} className="hover:text-foreground">
          {name}
        </Link>{" "}
        / <span className="text-foreground">Remove</span>
      </nav>
      <Card>
        <CardHeader>
          <div className="space-y-1.5">
            <CardTitle className="text-xl">Remove {name}?</CardTitle>
            <CardDescription>
              conduit will stop routing requests to it.{" "}
              {configDir ? (
                <>
                  The login in <code className="font-mono">{configDir}</code> stays on disk.
                </>
              ) : null}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <Form method="post" className="flex gap-2">
            <Button type="submit" variant="destructive">
              Remove provider
            </Button>
            <Button asChild variant="ghost">
              <Link to={`/providers/${id}`}>Keep it</Link>
            </Button>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
