import { createCookie } from "react-router";

export type Theme = "dark" | "light" | "system";
export const themes: Theme[] = ["dark", "light", "system"];

const themeCookie = createCookie("conduit_theme", {
  path: "/ui",
  sameSite: "lax",
  maxAge: 60 * 60 * 24 * 365,
});

/** Dark unless the visitor chose otherwise. */
export async function getTheme(request: Request): Promise<Theme> {
  const value: unknown = await themeCookie.parse(request.headers.get("cookie"));
  return value === "light" || value === "system" ? value : "dark";
}

export function serializeTheme(theme: Theme): Promise<string> {
  return themeCookie.serialize(theme);
}
