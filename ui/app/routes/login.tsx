import { Form, redirect } from "react-router";
import type { Route } from "./+types/login.ts";
import { Alert } from "#app/components/ui/alert.tsx";
import { Button } from "#app/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "#app/components/ui/card.tsx";
import { Input } from "#app/components/ui/input.tsx";
import { Label } from "#app/components/ui/label.tsx";
import { conduitContext } from "#app/context.ts";
import { isAuthenticated, keyMatches, signIn } from "#app/utils/security.server.ts";

export function meta() {
  return [{ title: "Sign in · conduit" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { apiKey } = context.get(conduitContext);
  if (await isAuthenticated(request, apiKey)) throw redirect("/");
  return null;
}

export async function action({ request, context }: Route.ActionArgs) {
  const { apiKey } = context.get(conduitContext);
  if (apiKey === undefined) throw redirect("/");
  const given = (await request.formData()).get("apiKey");
  if (typeof given !== "string" || !keyMatches(given, apiKey)) {
    return { error: "That is not the server's API key." };
  }
  const secure = new URL(request.url).protocol === "https:";
  return redirect("/", { headers: { "set-cookie": await signIn(apiKey, secure) } });
}

export default function Login({ actionData }: Route.ComponentProps) {
  return (
    <div className="mx-auto max-w-sm pt-12">
      <Card>
        <CardHeader>
          <div className="space-y-1.5">
            <CardTitle className="text-xl">Sign in</CardTitle>
            <CardDescription>Enter the server.api_key from your conduit config.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <Form method="post" className="space-y-4">
            {actionData?.error ? <Alert variant="destructive">{actionData.error}</Alert> : null}
            <div className="space-y-2">
              <Label htmlFor="apiKey">API key</Label>
              <Input
                id="apiKey"
                name="apiKey"
                type="password"
                autoComplete="current-password"
                autoFocus
                required
              />
            </div>
            <Button type="submit" className="w-full">
              Sign in
            </Button>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
