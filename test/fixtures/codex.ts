import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Trace, type TraceRecord } from "../../src/capture/recorder.ts";
import { defaultConfig, type CodexConfig } from "../../src/config.ts";
import type { ChatMessage, FunctionTool } from "../../src/openai/types.ts";
import type { CodexProvider } from "../../src/providers/codex/provider.ts";
import type { TurnEvent } from "../../src/providers/types.ts";

const fixture = fileURLToPath(new URL("./fake-codex.mjs", import.meta.url));
chmodSync(fixture, 0o755);

export const tools: FunctionTool[] = [
  {
    type: "function",
    function: { name: "lookup", description: "look something up", parameters: { type: "object" } },
  },
];

export function fakeCodex(login = "ok") {
  const dir = mkdtempSync(path.join(tmpdir(), "conduit-codex-test-"));
  const home = path.join(dir, "home");
  mkdirSync(home);
  writeFileSync(path.join(home, "auth.json"), login);
  const logFile = path.join(dir, "calls.log");
  const config: CodexConfig = {
    ...defaultConfig().codex,
    binary: fixture,
    toolSettleMs: 40,
    env: { CODEX_HOME: home, FAKE_CODEX_LOG: logFile },
  };
  const calls = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n") : []);
  return { dir, home, config, calls, file: (name: string) => path.join(dir, name) };
}

export interface Outcome {
  text: string;
  reasoning: string;
  calls: Array<{ id: string; name: string; args: string }>;
  done: Extract<TurnEvent, { type: "done" }> | undefined;
  error: Extract<TurnEvent, { type: "error" }> | undefined;
}

export async function collect(events: AsyncIterable<TurnEvent>): Promise<Outcome> {
  const out: Outcome = { text: "", reasoning: "", calls: [], done: undefined, error: undefined };
  for await (const e of events) {
    if (e.type === "text") out.text += e.delta;
    else if (e.type === "reasoning") out.reasoning += e.delta;
    else if (e.type === "tool_call_start") {
      out.calls[e.index] = { id: e.id, name: e.name, args: "" };
    } else if (e.type === "tool_call_args") out.calls[e.index]!.args += e.delta;
    else if (e.type === "done") out.done = e;
    else out.error = e;
  }
  return out;
}

export function turn(
  provider: CodexProvider,
  messages: ChatMessage[],
  options: { effort?: string; signal?: AbortSignal; withTools?: boolean } = {},
) {
  return collect(
    provider.turn({
      request: {
        model: "gpt-fake",
        messages,
        ...(options.withTools === false ? {} : { tools }),
      },
      upstreamModel: "gpt-fake",
      effort: options.effort,
      signal: options.signal ?? new AbortController().signal,
      trace: new Trace(false, {} as TraceRecord, undefined),
    }),
  );
}

export const user = (content: string): ChatMessage => ({ role: "user", content });
