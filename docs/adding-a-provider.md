# Adding a provider

A provider lets conduit serve another agent's models behind `/v1/chat/completions`. Claude
(`src/providers/claude/`) and Codex (`src/providers/codex/`) are the two worked examples. This
guide walks through what a new one (Grok, Copilot, ...) has to supply and what it gets for free.

## The shape of it

conduit keeps one live agent process per conversation. A request is matched to a live session, or
starts one. Everything about that is shared; an adapter only translates one agent's protocol.

```
                       shared (src/providers/)                       adapter (src/providers/<name>/)
 request ─▶ server.ts ─▶ ConversationProvider ─▶ matchSession ─▶ BaseSession.sendUser ─▶ <Name>Session ─▶ agent
              owns()      pool, failover, usage    reuse or cold start   turn lifecycle      its protocol
```

| Shared piece                                          | What it does                                                                                                         |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `conversationProvider.ts` (`ConversationProvider<S>`) | Session pool, request matching, idle reaping, eviction at `max_sessions`, failover to the next login, usage counters |
| `session.ts` (`BaseSession`)                          | Turn lifecycle, transcript, tool-call hand-off, client-disconnect handling, shutdown                                 |
| `matching.ts`, `conversation.ts`                      | Session identity (system prompt, tools, model, effort), continuation matching, cold start                            |
| `pendingTools.ts` (`PendingToolCalls`, `aliasFor`)    | Holds a model's tool call open until the HTTP client answers; makes tool names safe                                  |
| `failure.ts` (`classifyFailure`)                      | Rate limit vs. logged out, from a code and/or the message                                                            |
| `usage.ts`                                            | `ProviderUsage` and friends, the shape the UI renders                                                                |
| `store.ts`, `registry.ts`                             | Logins, priority, cooldowns, counters; failover only moves between logins of the same type                           |

## What you write

Five things are required: a session, a provider, a usage reader, config, and wiring. A history seeder
and a model-limits table are optional.

### 1. The session: `src/providers/<name>/session.ts`

Extend `BaseSession` and translate the agent's event stream into four calls:

| Call                                                                  | When                                                                           |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `this.emit({ type: "text", delta })`                                  | Streamed answer text. Also `reasoning` for thinking.                           |
| `this.startToolCall(id, name)`                                        | The model wants a client tool. Returns the call's index for argument deltas.   |
| `this.emit({ type: "tool_call_args", index, delta })`                 | Argument JSON, whole or streamed.                                              |
| `this.finish("stop" \| "length" \| "content_filter" \| "tool_calls")` | The HTTP turn is over.                                                         |
| `this.fail(message, failure)`                                         | The turn failed. Closes the session, since its state can no longer be trusted. |

Add token counts to `this.turn.usage` (`input`, `cacheRead`, `cacheWrite`, `output`) as the agent
reports them; `finish` turns them into the OpenAI `usage` object.

Then implement the abstract members:

- `label`: the agent's name, for logs and errors.
- `sendUser(blocks, incoming, trace, signal)`: call `this.begin(incoming, trace, signal)` for the
  event stream, hand `blocks` to the agent, return the stream.
- `deliverResult(callId, content)`: pass the client's tool result to the agent. The base class calls
  it for every result, and for a placeholder when the client skipped a call.
- `failureFor(reason)`: classify a close or error as `rate_limit`, `auth` or neither (see step 4).
- `teardown(reason)`: stop the process and remove anything you created. Called once.
- `onTurnBegin()` (optional): reset per-turn state.

Call `this.close(reason)` when the process dies unexpectedly. The base class fails the open turn and
removes the session from the pool.

**Tool calls are the part to get right.** The client only runs tools after the HTTP response ends,
but the agent asks for a result straight away. Use `PendingToolCalls`: when the agent asks, announce
the call to the client (`startToolCall`) and `await pending.wait(callId)`; `deliverResult` calls
`pending.deliver(callId, content)`. The turn then ends with `finish("tool_calls")`, and the next HTTP
request resumes the same session through `sendToolResults`.

How you know "the model is done asking" differs per agent:

- Claude reports `stop_reason: tool_use`, so it ends the turn on that event.
- Codex has no such event and may issue parallel calls a moment apart, so it ends the turn after
  `tool_settle_ms` with no new call.

Pick whichever your agent supports, and make sure parallel calls arrive as one batch.

Use the agent's own call id as the OpenAI `tool_call_id` if it has one. Continuation matching depends
on the client sending that same id back.

### 2. The provider: `src/providers/<name>/provider.ts`

Extend `ConversationProvider<YourSession>`:

```ts
export class GrokProvider extends ConversationProvider<GrokSession> {
  readonly name = "grok";
  protected readonly type = "grok" as const; // the ProviderType, added in step 5
  protected readonly agent: GrokConfig;
  readonly settings: ProviderSettings; // effort, reasoning output, context window defaults

  owns(model: string): boolean {} // see below
  async listModels(): Promise<ModelEntry[]> {}
  protected createSession(args: NewSessionArgs<GrokSession>): GrokSession {}
}
```

- `owns(model)` decides routing. `server.ts` asks each provider in turn; the first to say yes serves
  the request, and an id nobody claims goes to `default_provider`. Match on the id alone and keep
  it narrow, so providers do not overlap. Copilot's models also exist elsewhere, so it will need an
  explicit prefix or per-model route rather than a pattern.
- `listModels()` is cheap when there is nothing to list. Codex returns `[]` without spawning anything
  when no Codex login exists; follow that.
- `createSession(args)` builds your session. If `args.entry` is set, run under that login:
  `registry.<name>Config(args.entry)` gives the base config with the login's directory applied.
  `args.history` is earlier conversation to resume (step 6).

Everything else (matching, the pool, failover, usage counting, `close()`) comes from the base class.

### 3. A usage reader: `src/providers/<name>/usage.ts`

Return a `ProviderUsage` (account, plan windows, extra usage). Always resolve; on failure return
`failedUsage(error)` so the UI shows the reason instead of breaking. `registry.verify()` treats a
result with an `account` as "logged in".

### 4. Failure classification

Build a `TurnFailure` with `classifyFailure(code, message, { resetsAt, authCodes })` from
`failure.ts`. Normalize the agent's own error kinds to `"rate_limit"` or a code in `authCodes`; the
message fallback catches the rest. Always pass `resetsAt` (epoch milliseconds) when the agent says when
the limit lifts, so the login is skipped for exactly that long and not for the 5-minute default.

An error classified this way, arriving before anything reached the client, makes the base provider
retry on the next login of the same type.

### 5. Config, store, registry, wiring

These are small and mostly mechanical.

| File                        | Change                                                                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/config.ts`             | Add `"grok"` to `ProviderName`; a `GrokConfig extends AgentConfig` with only the extras; a default in `defaultConfig()`; a `[providers.grok]` block in `applyToml` that calls `applyAgentToml` for the shared keys |
| `src/providers/store.ts`    | Add a `grokEntry` zod object (`type: z.literal("grok")`) to the discriminated union and `providerTypes`                                                                                                            |
| `src/providers/registry.ts` | Add `grokConfig(entry)` (the base config plus the login directory env var), a case in `readUsage`, and a name in `PRODUCT`                                                                                         |
| `src/serve.ts`              | Register `providers.grok = new GrokProvider(config.grok, registry)`                                                                                                                                                |
| `src/providers/active.ts`   | Add it to `activeProviders`, which `conduit models` and `setup copilot` use                                                                                                                                        |
| `src/doctor.ts`             | Check the CLI is installed and each login is signed in                                                                                                                                                             |
| UI                          | `ui/app/routes/providers/new.tsx` (enum value and `<option>`), `ui/app/routes/providers/$id/index.tsx` (the login command and env variable), `ui/app/utils/providers.server.ts` if the list needs a label          |

Do not add an `enabled` flag. Registering the provider unconditionally is free: with no login of its
type, `listModels()` is empty and no process starts. A user turns a provider on by adding a login in the
web UI, with no restart.

`server.ts` needs no change: it routes by `owns()` and reads effort, reasoning and context window from
`provider.settings`.

### 6. History seeding (optional, but conversations break across restarts without it)

When a request arrives that no live session matches (a restart, a model switch, edited history), the
base provider calls `createSession` with `history`: everything before the final user message. Replay it
into the agent as real turns so the conversation carries on. Claude writes a transcript to its session
store; Codex injects Responses items with `thread/inject_items`. Keep the rules the two share:

- Pair every tool call with a result. A call the client never answered gets a placeholder
  (`NO_RESULT_TEXT`), and a stray result with no call becomes plain user text.
- Do not replay thinking. It is the client's summary, not the agent's, and some APIs sign it.
- Map tool names the same way the live path does (`aliasFor`), so history and new calls agree.

### 7. Model limits (optional)

If the agent reports a context window or output cap after a turn, feed it back so `/v1/models` is
accurate. Claude records limits per model (`onLimits`); Codex records the context window. Anything not
learned falls back to `provider.settings.contextWindow` or a static table (`claude/limits.ts`).

## Running the agent as a model

conduit wants the agent as a model, not as an agent on your machine. For each new adapter, decide how
to take away what the agent does by itself, and say so in the README and the primitives map.

- **Claude:** Claude Code's built-in tools are off, and the client's tools come in through an
  in-process MCP server. User settings, hooks and plugins are not loaded (`setting_sources = []`).
- **Codex:** the process runs on a throwaway `CODEX_HOME` holding only the login and a generated
  minimal `config.toml`. The thread has no environment, a read-only sandbox and approvals set to
  `never`, and approval requests are declined. Codex still advertises a few tools of its own that no
  config key removes; the empty environment contains them.

Whatever you choose:

- Never read the user's own config for the agent. Use a scratch directory with just the credentials
  linked in, and copy refreshed tokens back when you remove it (see `scratchConfigDir`,
  `scratchCodexHome`).
- Strip the agent's API-key environment variable by default, so usage bills the subscription
  (`strip_api_key`).
- Refuse or decline anything that would act on the machine.

## Tests

You do not need the real agent for tests, and CI has no logins.

1. **A fake agent.** Codex's `test/fixtures/fake-codex.mjs` is a small script that speaks the real
   protocol, picks behavior from the prompt text, and logs the methods it received. Copy that approach:
   it covers streaming, a tool round trip, parallel calls, a rate limit, a dying process and a missing
   binary in milliseconds. Put helpers in `test/fixtures/<name>.ts`.
2. **Cover these cases:** plain turn with usage; tool call then result in the same session; parallel
   tool calls as one batch; a follow-up message reusing the live session; cold start with history;
   rate limit with a reset time; failover to a second login; client disconnect mid-turn; the process
   dying; the binary missing; usage and models parsing; no login configured.
3. **Shared pieces are already tested** (`shared.test.ts`, `conversation.test.ts`), so test your
   adapter's translation, not the pool.
4. **Routing:** `test/routing.test.ts` shows how to add a fake provider and assert which model goes
   where.
5. Run the real thing once by hand: add a login in the web UI, then stream a chat and do a full tool
   round trip with a multi-call prompt. Fakes cannot tell you when your agent really ends a turn.

Before you push: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm primitives:check` and `pnpm test`.
Lint caps a file at 10 imports; if a file grows past that, split along a real seam (Claude's
`options.ts` and `active.ts` are examples).

## Docs to update

- `README.md`: the feature list, a section for the provider (like "Codex"), the Models and effort
  routing rules, and the config notes.
- `conduit.example.toml`: a `[providers.<name>]` block.
- `docs/architecture/primitives.toml`: a group and primitives for the adapter, and any invariants it
  adds (isolation, billing, containment). `pnpm primitives:check` fails if a path or anchor is missing.
- `TODO.md`: move the provider from the todo list to Done, and note any rough edges.

## Checklist

- [ ] `session.ts` extends `BaseSession`; tool calls go through `PendingToolCalls`
- [ ] `provider.ts` extends `ConversationProvider`; `owns()` is narrow; `listModels()` is cheap with no login
- [ ] Usage reader returns `failedUsage` instead of throwing
- [ ] Rate limits and logged-out errors classified, with `resetsAt` when known
- [ ] Config, store schema, registry, `serve.ts`, `active.ts`, `doctor.ts` and the UI updated
- [ ] No `enabled` flag; adding a login in the UI is enough
- [ ] History seeding pairs every tool call and skips thinking
- [ ] The agent runs isolated from the user's own config and API key, and cannot act on the machine
- [ ] Fake-agent tests plus one manual run against the real agent
- [ ] README, example config, primitives map and TODO updated
