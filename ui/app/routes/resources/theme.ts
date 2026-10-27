import { data } from "react-router";
import type { Route } from "./+types/theme.ts";
import { serializeTheme, themes, type Theme } from "#app/utils/theme.server.ts";

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const theme = form.get("theme");
  if (typeof theme !== "string" || !themes.includes(theme as Theme)) {
    throw data("Unknown theme", { status: 400 });
  }
  return data({ theme }, { headers: { "set-cookie": await serializeTheme(theme as Theme) } });
}
