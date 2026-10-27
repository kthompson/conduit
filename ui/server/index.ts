import { createReadStream, statSync } from "node:fs";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequestListener } from "@react-router/node";
import { RouterContextProvider, type ServerBuild } from "react-router";
import type { ConduitContext } from "../app/context.ts";

const uiDir = path.resolve(import.meta.dirname, "..");
const clientDir = path.join(uiDir, "build", "client");
const BASE = "/ui/";

export interface UiOptions extends Omit<ConduitContext, "dev"> {
  /** Run the Vite dev server in-process (HMR, React Router DevTools) instead of the built UI. */
  dev: boolean;
  /** Hostnames the UI answers to. "*" allows any. */
  allowedHosts: string[];
}

export interface UiHandle {
  /** True when the request path belongs to the UI. */
  owns(url: string | undefined): boolean;
  handle(req: IncomingMessage, res: ServerResponse): void;
  close(): Promise<void>;
}

const types: Record<string, string> = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".txt": "text/plain",
};

export async function createUiHandle(options: UiOptions): Promise<UiHandle> {
  let getBuild: () => Promise<ServerBuild>;
  let middlewares:
    | ((req: IncomingMessage, res: ServerResponse, next: () => void) => void)
    | undefined;
  let closeVite: (() => Promise<void>) | undefined;

  if (options.dev) {
    const { createServer } = await import("vite");
    const vite = await createServer({
      root: uiDir,
      appType: "custom",
      server: {
        middlewareMode: true,
        allowedHosts: options.allowedHosts.includes("*") ? true : options.allowedHosts,
      },
    });
    middlewares = vite.middlewares;
    closeVite = () => vite.close();
    getBuild = async () =>
      (await vite.ssrLoadModule("virtual:react-router/server-build")) as unknown as ServerBuild;
  } else {
    const build = (await import(
      pathToFileURL(path.join(uiDir, "build", "server", "index.js")).href
    )) as ServerBuild;
    getBuild = () => Promise.resolve(build);
  }

  const listener: RequestListener = createRequestListener({
    build: getBuild,
    mode: options.dev ? "development" : "production",
    getLoadContext: async () => {
      const build = await getBuild();
      const { conduitContext } = build.entry.module as unknown as {
        conduitContext: Parameters<RouterContextProvider["set"]>[0];
      };
      const context = new RouterContextProvider();
      const value: ConduitContext = {
        registry: options.registry,
        apiKey: options.apiKey,
        dev: options.dev,
        cspReportOnly: options.cspReportOnly,
      };
      context.set(conduitContext, value);
      return context;
    },
  });

  const hostAllowed = (req: IncomingMessage): boolean => {
    if (options.allowedHosts.includes("*")) return true;
    const header = req.headers.host ?? "";
    // Strip the port; IPv6 literals keep their brackets.
    const host = (
      header.startsWith("[")
        ? header.slice(0, header.indexOf("]") + 1)
        : (header.split(":")[0] ?? "")
    ).toLowerCase();
    return options.allowedHosts.includes(host);
  };

  return {
    owns: (url) =>
      url !== undefined && (url === "/ui" || url.startsWith(BASE) || url.startsWith("/ui?")),
    handle: (req, res) => {
      if (!hostAllowed(req)) {
        res.writeHead(403, { "content-type": "text/plain" }).end("Host not allowed");
        return;
      }
      if (req.url === "/ui" || req.url?.startsWith("/ui?")) {
        res.writeHead(308, { location: BASE }).end();
        return;
      }
      if (middlewares) {
        // Vite's base middleware strips /ui from req.url; React Router needs it back.
        const original = req.url;
        middlewares(req, res, () => {
          req.url = original;
          listener(req, res);
        });
        return;
      }
      if (!serveStatic(req, res)) listener(req, res);
    },
    close: async () => {
      await closeVite?.();
    },
  };
}

/** Serves built client assets; React Router handles everything else. */
function serveStatic(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const { pathname } = new URL(req.url ?? "/", "http://conduit");
  const relative = decodeURIComponent(pathname.slice(BASE.length));
  const file = path.resolve(clientDir, relative);
  if (relative === "" || !file.startsWith(clientDir + path.sep)) return false;
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  res.writeHead(200, {
    "content-type": types[path.extname(file)] ?? "application/octet-stream",
    "content-length": stat.size,
    // Vite fingerprints everything under assets/.
    "cache-control": relative.startsWith("assets/")
      ? "public, max-age=31536000, immutable"
      : "public, max-age=3600",
  });
  if (req.method === "HEAD") res.end();
  else createReadStream(file).pipe(res);
  return true;
}
