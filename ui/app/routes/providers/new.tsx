import { getFormProps, getInputProps, getSelectProps, useForm } from "@conform-to/react";
import { parseWithZod } from "@conform-to/zod/v4";
import { Form, Link, useNavigation } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/new.ts";
import { Field } from "#app/components/field.tsx";
import { Alert } from "#app/components/ui/alert.tsx";
import { Button } from "#app/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "#app/components/ui/card.tsx";
import { Input } from "#app/components/ui/input.tsx";
import { conduitContext } from "#app/context.ts";
import { redirectWithToast } from "#app/utils/toast.server.ts";

export function meta() {
  return [{ title: "Add provider · conduit" }];
}

const schema = z.object({
  type: z.enum(["claude", "codex"]),
  name: z
    .string("Name is required")
    .trim()
    .min(1, "Name is required")
    .max(64, "Keep the name under 64 characters"),
  configDir: z
    .string()
    .trim()
    .optional()
    .refine((v) => v === undefined || v === "" || v.startsWith("/") || v.startsWith("~"), {
      message: "Use an absolute path",
    }),
});

export async function action({ request, context }: Route.ActionArgs) {
  const { registry } = context.get(conduitContext);
  const submission = parseWithZod(await request.formData(), { schema });
  if (submission.status !== "success") return submission.reply();
  const { type, name, configDir } = submission.value;
  try {
    const entry = registry.store.add({ type, name, configDir });
    return await redirectWithToast(`/providers/${entry.id}`, {
      type: "success",
      title: `Added ${entry.name}`,
      description: "Log in with the command below, then verify.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const field = error instanceof Error && "field" in error ? String(error.field) : undefined;
    return submission.reply(
      field === "name" || field === "configDir"
        ? { fieldErrors: { [field]: [message] } }
        : { formErrors: [message] },
    );
  }
}

export default function NewProvider({ actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const [form, fields] = useForm({
    lastResult: actionData,
    constraint: undefined,
    shouldValidate: "onBlur",
    shouldRevalidate: "onInput",
    onValidate: ({ formData }) => parseWithZod(formData, { schema }),
  });
  const saving = navigation.state === "submitting";

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <nav className="text-sm text-muted-foreground" aria-label="Breadcrumb">
        <Link to="/" className="hover:text-foreground">
          Providers
        </Link>{" "}
        / <span className="text-foreground">Add</span>
      </nav>
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Add a provider</CardTitle>
        </CardHeader>
        <CardContent>
          <Form method="post" {...getFormProps(form)} className="space-y-5">
            {form.errors ? <Alert variant="destructive">{form.errors.join(" ")}</Alert> : null}
            <Field label="Type" field={fields.type}>
              <select
                {...getSelectProps(fields.type)}
                defaultValue="claude"
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <option value="claude" className="bg-popover">
                  Claude (Claude Code login)
                </option>
                <option value="codex" className="bg-popover">
                  Codex (ChatGPT login)
                </option>
              </select>
            </Field>
            <Field
              label="Name"
              field={fields.name}
              hint="Shown in the list, for example “Work Max”."
            >
              <Input
                {...getInputProps(fields.name, { type: "text" })}
                key={fields.name.key}
                autoComplete="off"
                placeholder="Work Max"
                autoFocus
              />
            </Field>
            <Field
              label="Config directory"
              field={fields.configDir}
              hint="Optional. Where this login is stored (CLAUDE_CONFIG_DIR or CODEX_HOME). Leave empty to use ~/.config/conduit/accounts/<name>. To reuse a Codex login you already have, enter ~/.codex."
            >
              <Input
                {...getInputProps(fields.configDir, { type: "text" })}
                key={fields.configDir.key}
                autoComplete="off"
                className="font-mono"
                placeholder="~/.config/conduit/accounts/work-max"
              />
            </Field>
            <div className="flex gap-2">
              <Button type="submit" disabled={saving}>
                {saving ? "Adding…" : "Add provider"}
              </Button>
              <Button asChild variant="ghost">
                <Link to="/">Cancel</Link>
              </Button>
            </div>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
