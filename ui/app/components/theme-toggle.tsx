import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect } from "react";
import { useFetcher, useRouteLoaderData } from "react-router";
import type { loader as rootLoader } from "#app/root.tsx";
import { cn } from "#app/utils/cn.ts";

const options = [
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "light", label: "Light", Icon: Sun },
  { value: "system", label: "System", Icon: Monitor },
] as const;

export function ThemeToggle() {
  const fetcher = useFetcher();
  const root = useRouteLoaderData<typeof rootLoader>("root");
  const chosen = fetcher.formData?.get("theme") ?? root?.theme ?? "dark";
  useEffect(() => {
    const dark =
      chosen === "dark" ||
      (chosen === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
  }, [chosen]);
  return (
    <fetcher.Form
      method="post"
      action="/resources/theme"
      className="flex rounded-md border p-0.5"
      aria-label="Theme"
    >
      {options.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="submit"
          name="theme"
          value={value}
          title={label}
          aria-label={label}
          aria-pressed={chosen === value}
          className={cn(
            "rounded-sm p-1.5 text-muted-foreground transition-colors hover:text-foreground",
            chosen === value && "bg-accent text-accent-foreground",
          )}
        >
          <Icon className="size-4" />
        </button>
      ))}
    </fetcher.Form>
  );
}
