import { PassThrough } from "node:stream";
import { createReadableStreamFromReadable } from "@react-router/node";
import { isbot } from "isbot";
import { renderToPipeableStream } from "react-dom/server";
import { ServerRouter, type EntryContext, type RouterContextProvider } from "react-router";
import { conduitContext } from "#app/context.ts";
import { NonceContext } from "#app/utils/nonce.ts";
import { newNonce, securityHeaders } from "#app/utils/security.server.ts";

export const streamTimeout = 10_000;

// conduit's server hands each request its context through this key, so it must be the build's own copy.
export { conduitContext } from "#app/context.ts";

export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  loadContext: RouterContextProvider,
) {
  const { dev, cspReportOnly } = loadContext.get(conduitContext);
  const nonce = newNonce();
  for (const [name, value] of securityHeaders(nonce, { dev, reportOnly: cspReportOnly })) {
    responseHeaders.set(name, value);
  }

  return new Promise<Response>((resolve, reject) => {
    let shellRendered = false;
    let status = responseStatusCode;
    const readyOption = isbot(request.headers.get("user-agent")) ? "onAllReady" : "onShellReady";

    const { pipe, abort } = renderToPipeableStream(
      <NonceContext.Provider value={nonce}>
        <ServerRouter context={routerContext} url={request.url} nonce={nonce} />
      </NonceContext.Provider>,
      {
        nonce,
        [readyOption]() {
          shellRendered = true;
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);
          responseHeaders.set("content-type", "text/html");
          resolve(new Response(stream, { headers: responseHeaders, status }));
          pipe(body);
        },
        onShellError: reject,
        onError(error: unknown) {
          status = 500;
          // Errors before the shell is sent reject above; later ones are logged only.
          if (shellRendered) console.error(error);
        },
      },
    );

    setTimeout(abort, streamTimeout + 1000);
  });
}
