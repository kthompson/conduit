import { useEffect } from "react";
import {
  data,
  Form,
  isRouteErrorResponse,
  Link,
  Links,
  Meta,
  Outlet,
  redirect,
  Scripts,
  ScrollRestoration,
  useRouteLoaderData,
} from "react-router";
import { toast as showToast } from "sonner";
import type { Route } from "./+types/root.ts";
import "./app.css";
import { ThemeToggle } from "#app/components/theme-toggle.tsx";
import { Toaster } from "#app/components/ui/sonner.tsx";
import { conduitContext } from "#app/context.ts";
import { useNonce } from "#app/utils/nonce.ts";
import { assertSameOrigin, isAuthenticated } from "#app/utils/security.server.ts";
import { getTheme, type Theme } from "#app/utils/theme.server.ts";
import { takeToast } from "#app/utils/toast.server.ts";

export const middleware: Route.MiddlewareFunction[] = [
  async ({ request, context }, next) => {
    assertSameOrigin(request);
    const { apiKey } = context.get(conduitContext);
    const path = new URL(request.url).pathname;
    const isLogin = /\/login(\.data)?$/.test(path);
    // Redirects thrown from middleware are not rewritten for the basename.
    if (!isLogin && !(await isAuthenticated(request, apiKey))) throw redirect("/ui/login");
    return next();
  },
];

export async function loader({ request, context }: Route.LoaderArgs) {
  const { apiKey } = context.get(conduitContext);
  const { toast, headers } = await takeToast(request);
  return data(
    {
      theme: await getTheme(request),
      toast,
      signedIn: apiKey !== undefined && (await isAuthenticated(request, apiKey)),
    },
    { headers },
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const nonce = useNonce();
  const loaderData = useRouteLoaderData<typeof loader>("root");
  const theme: Theme = loaderData?.theme ?? "dark";
  return (
    <html lang="en" className={theme === "light" ? "" : "dark"} suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="data:," />
        <title>conduit</title>
        <Meta />
        <Links />
        {theme === "system" ? (
          <script
            nonce={nonce}
            // Resolves the OS preference before first paint.
            dangerouslySetInnerHTML={{
              __html: `document.documentElement.classList.toggle("dark", matchMedia("(prefers-color-scheme: dark)").matches)`,
            }}
          />
        ) : null}
      </head>
      <body className="min-h-screen">
        {children}
        <Toaster position="bottom-right" theme={theme} />
        <ScrollRestoration nonce={nonce} />
        <Scripts nonce={nonce} />
      </body>
    </html>
  );
}

export default function App({ loaderData }: Route.ComponentProps) {
  const { toast, signedIn } = loaderData;
  useEffect(() => {
    if (!toast) return;
    showToast[toast.type](toast.title, toast.description ? { description: toast.description } : {});
  }, [toast]);

  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col px-4">
      <header className="flex items-center justify-between py-6">
        <Link to="/" className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <span className="inline-block size-2.5 rounded-full bg-primary" />
          conduit
        </Link>
        <div className="flex items-center gap-3">
          {signedIn ? (
            <Form method="post" action="/logout">
              <button type="submit" className="text-sm text-muted-foreground hover:text-foreground">
                Sign out
              </button>
            </Form>
          ) : null}
          <ThemeToggle />
        </div>
      </header>
      <main className="flex-1 pb-16">
        <Outlet />
      </main>
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let detail = error instanceof Error ? error.message : "Unexpected error";
  if (isRouteErrorResponse(error)) {
    title = error.status === 404 ? "Page not found" : `${error.status} ${error.statusText}`;
    detail = typeof error.data === "string" ? error.data : "";
  }
  return (
    <div className="mx-auto max-w-xl px-4 py-24 text-center">
      <h1 className="text-2xl font-semibold">{title}</h1>
      {detail ? <p className="mt-2 text-muted-foreground">{detail}</p> : null}
      <Link to="/" className="mt-6 inline-block text-primary underline-offset-4 hover:underline">
        Back to providers
      </Link>
    </div>
  );
}
