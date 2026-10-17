# conduit: OpenAI-compatible proxy over local coding-agent providers

Status: **plan. Built so far: the capture server (section 8a, `conduit capture`, see docs/capture.md). First capture against the Copilot app is in (section 11): Chat Completions streaming, app-side tool execution, cwd and session id in the system prompt; leaning model mode as the Copilot default. Everything else is still plan.** Reference implementation: `/home/kevin/code/personal/t3code`.

## 1. Goal

A C#/.NET service that exposes an OpenAI-compatible HTTP API. Behind it are the same *providers* t3code
manages (Claude Code, Codex, Cursor, Grok, OpenCode, Pi, any ACP agent). Each provider is a locally
installed agent runtime that is already signed in with the user's own subscription. The proxy lets any
OpenAI client (SDKs, Open WebUI, Continue, LiteLLM, ...) talk to those agents.

Confirmed: "desktop applications" means the same local agent CLIs/runtimes t3code wraps, not GUI
automation.

**Primary consumer: the GitHub Copilot desktop app** ([GitHub Copilot app](https://github.com/features/ai/github-app),
bring-your-own-key / custom OpenAI-compatible endpoint). **Mode: model mode is the default for Copilot**
(decided 2026-10-17 from the first capture, section 11). Two ways to use a provider runtime exist, and both are
per-instance settings:
- *Agent mode:* run the full native agent (its own tools, in a real working directory) and stream its
  work back as an ordinary assistant response. Copilot sees a "model" that is really a coding agent.
- *Model mode:* use the runtime only for inference. Tools are disabled or supplied by the caller, and the
  caller's harness (Copilot) does the acting.
Agent mode was the original objective, but the capture showed Copilot is itself an agent harness that sends its
own tools and runs the model's `tool_calls`, so model mode is the default and agent mode is an opt-in instance
setting for plain OpenAI clients (phase 8).

Things worth knowing about the consumer (from GitHub's own page and secondary coverage, verify against
current docs):
- BYOK in the Copilot app is described as a public preview; it takes an endpoint, key and wire type, and
  reportedly requires tool calling, streaming and a >=128k context window.
- The app *already* offers Claude Code and Codex as built-in third-party agents on some plans. So the
  proxy's unique value is the rest of the provider set (Cursor, Grok, OpenCode, Pi, ACP agents),
  multiple accounts per driver, and use from any OpenAI-compatible client, not Claude/Codex inside
  Copilot alone.

A consequence of agent mode behind a chat client (the reason it is not the Copilot default): **two agent loops are nested.** Copilot expects to
run its own tools on a model's `tool_calls`. Here the inner native agent runs its tools itself, and
nothing in the response asks Copilot to run anything. Section 5 spells out what that means.

## 2. Which API: Responses-shaped core, Chat Completions ships first

| | Responses (`/v1/responses`) | Chat Completions (`/v1/chat/completions`) |
|---|---|---|
| Output model | typed *items*: message, reasoning, function_call, ... | one message + `tool_calls` |
| Streaming | typed events (`response.output_text.delta`, `response.output_item.added`, ...) | untyped `delta` chunks |
| Reasoning | first-class (`reasoning.effort`, summaries) | ad hoc (`reasoning_effort`, non-standard `reasoning_content`) |
| State | `previous_response_id`, `conversation`, `store`, background mode | none, client resends history |
| Ecosystem reach | newer; OpenAI SDK, Codex-style clients | near-universal |

Responses is the more full-featured API and the better semantic match for an agent. An agent turn is a
sequence of items (thinking, tool work, message), and agent sessions are stateful. **Decision: implement
Responses as the primary *design* surface (the internal item stream is Responses-shaped), with Chat
Completions as a second, thinner front end over the same model.** Chat Completions is cheap to add once
the item stream exists, and it is what most third-party tools actually send. Because Copilot is the first
consumer, **Chat Completions ships first (phase 2) and Responses follows (phase 4).** Also: `GET /v1/models` (required by almost every client).

Copilot fit: Copilot BYOK lets the user pick the wire format per model (Chat Completions, Responses, or
Anthropic-style Messages) and wants streaming ([BYOK post](https://code.visualstudio.com/blogs/2025/10/22/bring-your-own-key),
[Copilot CLI BYOK](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-byok-models)).
Which wire formats the *desktop app* supports is not documented in anything I found, so phase 0 starts
with a capture server that records exactly what the app sends. Chat Completions ships first (phase 2),
Responses next (phase 4). An Anthropic-compatible `/v1/messages` front end is a possible later add-on.

Extension endpoints (non-OpenAI, namespaced so they never collide):
- `GET /v1/providers`: provider instance snapshots (status, auth state, version, models, capabilities).
  This mirrors t3code's `ServerProvider`.
- `POST /v1/providers/{instanceId}/refresh`: re-probe status/models.

## 3. What t3code's provider framework actually is (findings)

Key files, all under `t3code/`:

- **Driver vs. instance.** `packages/provider-core/src/server/driver.ts`
  - `ProviderDriver<Config>` is the *kind* of integration. It has `driverKind`, `metadata`,
    `configSchema`, `defaultConfig()`, and `create(input) -> ProviderInstance` (scoped, so it owns its
    resources).
  - `ProviderInstance` is one configured account/lifecycle. It has `instanceId`, `driverKind`,
    `snapshot` (a `ManagedServerProvider`: `getSnapshot`, `refresh`, `streamChanges`),
    `orchestrationAdapter`, `textGeneration`, optional `auth`, `refreshModels`, and
    usage/maintenance hooks.
  - Rule: **route work by instance, never by driver.** Two instances of one driver share no mutable
    state. `docs/internals/providers.md` has the isolation rules, including dropping ambient
    credentials per instance.
- **Configuration.** `packages/contracts/src/providerInstance.ts`. Settings hold
  `providerInstances: Record<instanceId, { driver, displayName?, accentColor?, enabled?, environment?[], config? }>`.
  `config` is opaque to the envelope and decoded by the driver's own schema. Unknown drivers or invalid
  config become *unavailable shadow snapshots*, not crashes. `instanceId` defaults to the driver kind.
- **Registry.** `apps/server/src/provider/ProviderInstanceRegistry.ts` builds one live entry per config
  entry in its own `Scope`. It diffs on settings change (hot reload), publishes changes, and tracks
  `listUnavailable`.
- **Built-in drivers list.** `apps/server/src/provider/builtInDrivers.ts` (+ adapter list in
  `orchestration-v2/builtInProviderAdapterDrivers.ts`). Drivers are plain values in an array. There are
  no per-driver DI tags, because the same driver is instantiated many times.
- **Adapter contract.** `packages/provider-core/src/server/ProviderAdapter.ts` (`ProviderAdapterV2`):
  `getCapabilities()`, `planSelectionTransition()`, `openSession(...) -> SessionRuntime`.
  `SessionRuntime` has `ensureThread`, `resumeThread`, `startTurn`, `steerTurn`, `interruptTurn`,
  `respondToRuntimeRequest`, `readThreadSnapshot`, `rollbackThread`, `forkThread`, and an `events` stream.
  Events are normalized (`message.updated`, `turn_item.updated`, `runtime_request.updated`, `plan.updated`,
  `turn.terminal` with `completed | interrupted | cancelled | failed`, ...).
- **Capabilities.** `docs/orchestration-v2/provider-capability-system.md`. Every adapter declares what it
  really supports (sessions, threads, turns, streaming, tools, approvals, planning, subagents, context,
  checkpointing, identity, runtimePolicy). The rest of the system reads capabilities, never the driver
  kind, and degrades explicitly.
- **t3code runs Claude as a full agent, and also as a plain model.** The Claude adapter
  (`orchestration-v2/Adapters/ClaudeAdapterV2.ts`) calls the Agent SDK with the `claude_code` system
  prompt preset, the Claude Code tool preset, the project directory as `cwd`, `resume`/`sessionId` for
  native sessions, injected MCP servers, partial-message streaming, and a `permissionMode` derived from
  the thread's runtime mode (`approval-required` -> `default`, `auto-accept-edits` -> `acceptEdits`,
  `auto` -> `auto`, `full-access` -> `bypassPermissions`). Approval prompts come back through
  `canUseTool` and are shown to a human in the T3 UI. Separately, every `ProviderInstance` also has a
  `textGeneration` face (`textGeneration/ClaudeTextGeneration.ts`) for one-shot jobs such as commit
  messages and thread titles. That runs `claude` with `--tools ""`, no agent loop. So the framework
  already models both uses: `orchestrationAdapter` is agent mode and `textGeneration` is model mode.
  The important difference from our case: **t3code always has a human and an approval UI in front of the
  agent. An API proxy does not.**
- **Host seam.** `ProviderHost` is the only door from a provider package back into the server: paths,
  settings (get/changes), background-work gating, attachment resolution, namespaced credentials.
- **Packaging.** One `provider-<name>` package per driver (`./settings`, `./client`, `./server`,
  `./testing`) over a shared `provider-core`. Flavors of the shared ACP adapter (Cursor, Grok,
  Antigravity) stay small. `docs/internals/adding-a-provider.md` lists "traps": setup must not happen as
  a health-check side effect, "default" model is a sentinel, stop-before-turn-started races, usage limits
  are not generic failures, etc.
- **Transports per driver.**
  - Claude: `@anthropic-ai/claude-agent-sdk`, which drives the `claude` CLI.
  - Codex: `codex app-server` JSON-RPC over stdio. Types are generated from its schema
    (`packages/effect-codex-app-server`).
  - Cursor / Grok / Antigravity / ACP Registry: Agent Client Protocol over stdio (`packages/effect-acp`,
    `provider-acp`).
  - OpenCode: its local HTTP server. Pi: its RPC mode.

## 4. Architecture for the C# port

Mirror the layering and names, translated to .NET idioms:

| t3code (Effect/TS) | C# |
|---|---|
| `Effect<A,E,R>` + `Scope` | `Task`/`ValueTask` + `CancellationToken`; `IAsyncDisposable` for scoped resources |
| `Stream<A,E>` | `IAsyncEnumerable<T>` / `System.Threading.Channels` |
| `Context.Service` | DI interface + `IOptionsMonitor` where hot reload matters |
| `Schema` decode | `System.Text.Json` source-generated records, strict decode at the config boundary |
| Tagged errors | sealed exception hierarchy or `Result<T, ProviderError>`; map to OpenAI error objects at the edge |

Solution layout (.NET 10, ASP.NET Core minimal APIs, xUnit):

```
src/
  Conduit.Contracts/        ProviderInstanceConfig, ServerProvider snapshot, ModelSelection, capabilities, event types
  Conduit.Provider.Core/    IProviderDriver, IProviderInstance, IProviderAdapter, ISessionRuntime,
                               IProviderHost, ManagedProviderSnapshot (cache + refresh + change stream),
                               ModelCatalog, instance env merge, failure classification
  Conduit.Protocols.Acp/    ACP client over stdio (see 6)
  Conduit.Protocols.Codex/  Codex app-server JSON-RPC client (types generated from schema)
  Conduit.Protocols.Claude/ claude CLI stream-json client
  Conduit.Provider.Claude/  ClaudeDriver, settings, status probe, adapter
  Conduit.Provider.Codex/
  Conduit.Provider.Acp/     generic ACP adapter + Cursor/Grok/Antigravity flavors + registry driver
  Conduit.Provider.OpenCode/, .Pi/   later
  Conduit.Registry/         ProviderInstanceRegistry: build/diff/hot-reload, unavailable shadows
  Conduit.OpenAi/           request/response DTOs, translators (item stream <-> Responses / Chat chunks), SSE writer
  Conduit.Server/           host, auth, routes, config loading, session store
  Conduit.Cli/              `conduit` executable: Spectre.Console.Cli commands + setup wizard (hosts Server for `serve`)
tests/                         unit + replay-fixture + OpenAI-SDK contract tests
```

Rules carried over from t3code:
- Provider packages talk to the host only through `IProviderHost`. They never reference `Server`.
- Capabilities gate every optional call. The OpenAI layer never branches on driver kind.
- Instances are isolated: own process(es), own env, own credentials. Strip inherited credentials the
  instance did not configure.
- Bad config or missing binary yields an *unavailable* instance listed in `/v1/providers`, not a startup
  failure.
- Status/model probes must not open sessions that can start MCP servers, run hooks, or launch a login.
- `ISessionRuntime` keeps t3code's shape. v1 implements `EnsureThread`, `ResumeThread`, `StartTurn`,
  `InterruptTurn`, `RespondToRuntimeRequest` and the `Events` stream. Rollback, fork, steer and subagents
  stay in the interface as optional, capability-gated members and return "unsupported". They can be
  filled in later without reshaping anything.

### Config file (HOCON)

Same envelope as t3code (`providerInstances` map of `{driver, displayName, enabled, environment, config}`),
written as HOCON. Default location `~/.config/conduit/conduit.conf` (`--config` overrides).

```hocon
server {
  listen = "127.0.0.1:8787"
  api-keys = [ ${?CONDUIT_KEY} ]      # secrets via env substitution, never required inline
}

provider-instances {
  claude {
    driver = claudeAgent
    enabled = true
    mode = model                          # model (default) | agent
    runtime-mode = auto-accept-edits      # driver-enforced; default = most restrictive the driver offers
    workspace = "~/code"                  # default cwd when the request doesn't name one
    allowed-roots = [ "~/code", "~/.copilot/worktrees" ]
    activity = compact                    # off | compact | verbose
    home = real                           # real | isolated
    config { binary-path = "claude" }
  }
  claude-work {
    driver = claudeAgent
    display-name = "Claude (work)"
    home = isolated
    environment = [ { name = CLAUDE_CONFIG_DIR, value = "~/.claude-work" } ]
  }
  codex { driver = codex, enabled = true, runtime-mode = approval-required }
}

include "instances.d/"                    # optional: files written by `conduit setup`
```

Driver kind slugs match t3code (`claudeAgent`, `codex`, `cursor`, `grok`, `opencode`, `pi`,
`acpRegistry`, ...). Instance ids keep t3code's slug rules (`^[a-zA-Z][a-zA-Z0-9_-]*$`, max 64).

HOCON notes:
- Parser: the [`Hocon`](https://www.nuget.org/packages/Hocon) package (Akka.NET's parser) or
  `Hocon.Extensions.Configuration` to plug into `Microsoft.Extensions.Configuration`. Its last
  versions listed in search were from 2021, so the spike (phase 0) verifies it parses what we need
  on .NET 10 (substitutions, `include`, `${?ENV}`). Fallback: a small HOCON-subset reader or `Hocon.Json`
  conversion.
- HOCON libraries are **read-only**: they do not round-trip comments or formatting. So the CLI wizard
  never rewrites the user's hand-edited file. It writes one generated file per instance into
  `instances.d/<id>.conf` (fully owned by the tool) and the main file stays the user's. Hot reload watches
  the whole set.
- Strict validation at the boundary: a typed options record per driver (as t3code's `configSchema`), with
  `conduit config validate` reporting key paths and line numbers where the parser gives them.

## 5. Mapping agents onto the OpenAI surface (the hard part)

An OpenAI request is a stateless "model + messages". These providers are stateful agents with their own
tools. The plan makes each mismatch an explicit decision.

1. **Model ids.** `GET /v1/models` lists `<instanceId>/<modelSlug>` (e.g. `claude-work/claude-opus-4-1`),
   plus `<instanceId>` alone for the instance's default model. Only enabled, ready instances are listed.
   Model capability option descriptors (effort, thinking, fast mode, ...) are surfaced as extra fields.
   `reasoning.effort` / `reasoning_effort` map onto them.
2. **Sessions / state.** Agent mode needs real continuity, so this is the core of the translation layer (see
   also item 3, "conversation identity").
   - Responses: `previous_response_id` and `conversation` map to a provider thread, resumed through
     native resume. A server-side session table (SQLite) maps response id -> (instance, provider thread
     id, cwd).
   - Chat Completions is stateless: sessions are recovered by id or by prefix fingerprint (item 3).
     Session table (SQLite) maps (instance, fingerprint chain) -> provider thread id, cwd, last-used.
   - Context handoff reuses t3code's idea of summarizing history when a provider cannot ingest it
     natively. Defer the summarizer; start with "inject transcript as context".
3. **Agent mode (opt-in per instance; phase 8, not the Copilot default).** The instance's native agent runs with its own tools, in a real working
   directory, against a native provider session, under the instance's runtime mode (see 4).
   - *Native tool activity is never sent as `tool_calls`.* Copilot would try to run an unknown tool and
     fail. Activity is rendered into the assistant text stream instead (instance setting
     `activity = off | compact | verbose`, default `compact`): short markdown lines such as
     "ran `npm test` (exit 0)", "edited `src/a.ts`", plus the agent's final answer. Reasoning goes to
     the reasoning channel where the client understands one. The spike checks what Copilot actually
     displays.
   - The request's own `tools` are **ignored in agent mode** (with an `X-Ignored-Params` header). The
     agent has its own. A later "hybrid" option can bridge selected client tools to the agent through an
     MCP bridge (t3code injects a thread-scoped MCP server the same way). Not v1.
   - **Conversation identity (critical, and the main design problem).** Chat Completions is stateless
     and Copilot resends history. The proxy must map each request to the right native session or every
     turn would start cold and lose the agent's context.
     1. Responses: `previous_response_id` / `conversation` is an exact lookup.
     2. Explicit ids if the client sends any (`X-Session-Id`, `user`, `metadata`). The capture found none in
        headers or body, but the Copilot app puts `Session folder: .../session-state/<uuid>` in the system
        prompt; use that uuid (section 11, capture findings).
     3. Otherwise a **prefix fingerprint**: per session, store a hash chain over the *user* messages
        seen so far (assistant text is excluded because clients re-render or trim it). A new request
        whose user messages `[0..n-1]` hash-match a session's chain, plus new trailing message(s), is
        resumed on that session and only the new content is sent. No match: new session, with the
        supplied history replayed as context. A client that compacts or rewrites history gets a new
        session; that is acceptable and logged.
     4. Concurrent requests on one session: serialize (queue) or reject with 409, configurable.
   - **Working directory.** Copilot runs sessions in per-task worktrees, so a fixed cwd is wrong. Order of
     resolution: explicit `X-Workspace` header or `metadata.cwd` (if the client can send one); else the
     `* Current working directory: <path>` line of the system prompt (confirmed present by the capture; match
     that line only, the prompt mentions other sessions' paths too) when it falls under an allowlisted root;
     else the instance's configured default workspace. Anything resolved must be inside
     `allowed-roots`. Whether Copilot puts its worktree path in the prompt is a phase-0 question; if it
     doesn't, a per-instance fixed workspace is the fallback and the main usability limit.
   - **Long turns.** Agent turns take seconds to minutes. Respond with headers and the first chunk
     immediately, send SSE keep-alive comments about every 15 s, and stream activity lines as progress,
     so client idle timeouts do not trip. Client disconnect interrupts the turn (honoring t3code's
     "stop before the turn started" trap), configurable to `continue`.
   - **Latency budget** (250-500 ms). Interpreted as *proxy overhead*, not model time: request received
     to first SSE byte <= 100 ms, and to the prompt being handed to a ready native session <= 250 ms at
     p95, on a warm session. A model cannot produce its first token in 250-500 ms after an agent loop
     starts, so end-to-end time-to-first-token is not something the proxy can promise; please confirm
     this reading. Cold paths cost more, and differ by driver: Codex app-server and ACP agents serve many
     sessions/cwds from one long-lived process (cheap new session), whereas a Claude CLI session is
     one process per session and its start is the slowest cold path. Mitigations: persistent session
     processes with idle reaping, a pre-warmed process pool where the cwd is not baked in, and an
     immediate "starting..." progress chunk. Phase 0 measures real cold and warm numbers per driver.
4. **Permissions: this is the central safety problem in agent mode.** An HTTP caller can make an agent run
   commands and edit files on the host, and there is no human at the other end to answer approval
   prompts.
   - Each instance has one fixed **runtime mode**, using t3code's vocabulary and limited to what the
     driver natively enforces (`supportedRuntimeModes`): `approval-required`, `auto-accept-edits`,
     `auto`, `full-access`. **Default is the most restrictive mode the driver offers**; anything wider is
     set explicitly in config, and the wizard asks for a typed confirmation for `full-access`.
     Never imitate a missing mode by answering approvals in the proxy (t3code's rule).
   - Approval requests that arrive while unattended are **declined** (every request must have a decline
     the provider honors), and the decline is shown in the activity stream so the user sees why the
     agent stopped. Phase 7 adds **approve-in-chat**: the turn ends with a question, and the user's next
     message is the answer, mapped to the provider's pending request. This mirrors t3code's
     message-response runtime requests.
   - `allowed-roots` restricts which directories a request can select as the working directory.
   - Use the provider's own sandbox where it exists (Codex sandbox policy, Claude permission rules,
     Cursor/Grok modes). Capability flags say which are available.
   - *Config leakage:* the agent reads user-level config (hooks, MCP servers, skills, CLAUDE.md /
     AGENTS.md, plugins) and t3code warns these can run before the prompt. In agent mode that config is
     arguably wanted (it is the user's agent), so isolation is **per-instance and explicit**: an
     instance either uses the user's real home (convenient, trusted) or a managed isolated home
     (reproducible). Setup asks which. Two accounts of one driver always get separate homes.
   - *The endpoint:* bearer key required, loopback by default, refuse non-loopback without a key. The
     key is effectively a shell on the machine, and the docs say so.
5. **Model mode (the default; decided from the capture).** An instance setting `mode = model` turns the native agent
   into a plain completion engine: built-in tools off, caller's `tools` exposed and captured as `tool_calls`,
   stateless replay, empty scratch cwd. That is what you want behind a harness that brings its own
   tools, and the Copilot app is one (section 11). It is built first (phase 2); agent mode follows in phase 8.
   Since it is a per-instance setting, one driver can have a `claude` (model) and a `claude-agent` (agent) instance
   side by side. In model mode the permission problem in item 4 mostly disappears (nothing runs on the host
   unless Copilot runs it), but the request's tool list and system prompt (about 36-39 KB per turn) pass through
   to the runtime, and a `tool_calls` reply makes Copilot execute it.
6. **Streaming translation.** One internal item stream, two serializers.
   - assistant text delta -> `response.output_text.delta` / `choices[].delta.content`
   - reasoning delta -> `response.reasoning_summary_text.delta` / `delta.reasoning_content` (flagged as non-standard)
   - `turn.terminal` `completed` -> `response.completed` / final chunk `finish_reason: "stop"`
   - `failed` -> `response.failed` or a proper HTTP error pre-stream. A `usage_limit` failure becomes 429
     with `Retry-After` from the reset time.
   - `interrupted`/`cancelled` -> `incomplete` / client disconnect. Client disconnect must call
     `InterruptTurn` (and handle the "stop before turn started" race t3code documents).
   - token usage -> `usage` (`stream_options.include_usage` honored)
7. **Inputs.** Text first. Images next (`input_image` / `image_url`), written to an attachment dir that
   the agent is granted read access to (t3code's attachment boundary). `file` inputs later.
   `response_format` / `text.format` JSON schema: prompt-enforced plus validate-and-retry, marked
   best-effort.
8. **Unsupported / ignored params** (`temperature`, `top_p`, `logprobs`, `n>1`, ...) are accepted and
   ignored with a response header `X-Ignored-Params`, except where ignoring changes meaning. Those return
   400.
9. **Auth to the proxy.** Bearer API keys from config, binds loopback by default. Refuse to start on a
   non-loopback address without at least one key.
10. **Concurrency.** Provider sessions are heavy processes. Add per-instance max-concurrent-sessions with
    queueing, idle session reaping, and clean child-process teardown (kill only PIDs we spawned, as in
    t3code's AGENTS.md).

## 6. Provider transports: what to build vs. reuse

No official .NET SDKs exist for these. Findings (community packages, none verified for maintenance):

- **ACP**: community packages exist (`AgentClientProtocol` 0.1.5 by nuskey8, `LibAcp`, `AcpSdk` built on
  StreamJsonRpc). Spike two of them against Cursor/Grok. If none holds up, write a thin client. ACP is
  JSON-RPC over stdio, so that is small. One ACP adapter covers Cursor, Grok, Antigravity, Pi (via
  registry) and the whole ACP Registry.
- **Claude**: the official Agent SDK is TS/Python only. Community .NET wrappers of `claude` CLI
  `stream-json` exist (`ClaudeCode.Net`, `ClaudeAgentSdk.DotNet`, ...), but the protocol is undocumented
  and unstable. Preferred: own thin client modeled on the TS SDK (`--input-format stream-json
  --output-format stream-json --include-partial-messages`, control requests for interrupt/permissions),
  with replay fixtures to catch protocol drift. Fallback: small Node sidecar using the official SDK.
- **Codex**: `codex app-server` is JSON-RPC over stdio with a generator for its JSON schema
  (`codex app-server generate-json-schema`). Generate C# DTOs from that schema (NJsonSchema/quicktype)
  and commit them, pinned to a Codex version, as t3code does.
- **OpenCode / Pi**: later; local HTTP / RPC, straightforward once the core exists.

## 7. CLI UX

A single `conduit` executable (a .NET global tool / self-contained binary). Built on
[Spectre.Console.Cli](https://spectreconsole.net/) for commands, plus Spectre prompts for the menus.
Every interactive flow has a non-interactive equivalent (flags, or `--yes`), so it scripts and runs
headless.

| Command | Purpose |
|---|---|
| `conduit setup` | Interactive wizard (below). Safe to re-run. |
| `conduit serve` | Run the server in the foreground. Prints listen address, key hint, and each instance's state. `--config`, `--listen`. |
| `conduit providers [list\|status <id>\|refresh <id>\|add\|remove <id>\|enable\|disable]` | Manage instances. `add` is the wizard's instance step on its own. |
| `conduit models [--instance <id>]` | What `/v1/models` would return, with per-model capabilities. |
| `conduit keys [create\|list\|revoke]` | Proxy API keys (stored hashed). |
| `conduit doctor` | Diagnoses: binary found/version, auth state, config isolation OK, port free, sample one-token completion per instance. |
| `conduit config [path\|validate\|show]` | Locate, validate and print the merged HOCON (secrets redacted). |
| `conduit connect copilot` | Prints the values to enter in the Copilot app's custom-provider form (endpoint, key, wire type, model ids). Writes settings itself only if the app exposes a documented config file. |
| `conduit sessions [list\|show <id>\|kill <id>]` | Inspect and stop live agent sessions (cwd, mode, age, last activity). |
| `conduit capture [report]` | Dev tool: logging OpenAI-compatible endpoint with canned scenarios (section 8a), used in phase 0 against the Copilot app. |

`setup` wizard flow:
1. Detect installed runtimes (`claude`, `codex`, `cursor-agent`, `grok`, `opencode`, `pi`, ACP
   registry entries) by running each driver's *non-side-effecting* probe (version and auth state only,
   per t3code's "setup must not happen as a health-check side effect" rule).
2. Menu: pick which to enable, name each instance (default id = driver kind), optionally add a second
   account (separate home/env), pick the runtime mode (default is the most restrictive the driver
   offers; `full-access` needs a typed confirmation), the default workspace and allowed roots, and
   real vs. isolated home.
3. For "not signed in" runtimes, show the runtime's own login command rather than driving the login
   inside our process (v1). Re-probe after the user confirms.
4. Choose listen address, generate an API key (printed once), write `instances.d/<id>.conf` and the main
   file if absent.
5. Offer to run `doctor`, then `serve`, and print the `connect copilot` snippet.

Service mode (systemd user unit / launchd) is a later nicety, not v1.

## 8. Phases

0. **Spikes (2-3 days).** Throwaway code only. In priority order:
   a. **Capture server first (no providers needed).** See section 8a. Point the Copilot app at it and
      record what it sends and how it reacts. **Its findings decide agent vs. model default, cwd
      handling, conversation identity and the activity format**, so everything else waits on it.
   b. **Cold/warm latency per runtime.** Drive claude, codex (app-server) and one ACP agent from a
      console: time to spawn, initialize, new session, first event. Check the 250-500 ms overhead reading
      holds for warm sessions and see what a cold start costs.
   c. **Native-agent control surface.** Can each runtime be driven with: a chosen runtime mode, declined
      approvals, interrupt, resume by id, and isolation of user config? Claude transport choice (own
      stream-json client vs. sidecar) and the ACP library are decided here.
   d. HOCON parser works on .NET 10 for what we need.
   Output: recorded fixtures and go/no-go notes. A runtime that cannot be driven unattended with a
   native permission mode is deferred.
1. **Core + skeleton.** Contracts, `Provider.Core`, HOCON config load/diff/hot reload, registry with
   unavailable shadows, `ManagedProviderSnapshot`, fake in-memory provider, ASP.NET host with API-key
   auth, `/healthz`, `/v1/models`, `/v1/providers`, session table, and CLI `serve`, `config`,
   `providers`, `models`, `keys`, `sessions`.
2. **Model mode on Claude via Chat Completions** (decided from the capture; Copilot brings its own tools and runs
   `tool_calls` itself). Claude driver, probe, adapter with the runtime's built-in tools off, the request's `tools`
   exposed to the model and returned as `tool_calls` (and `role: tool` results fed back) without the runtime
   executing anything, stateless replay of the resent history (no native session needed), streaming with keep-alives,
   interrupt on disconnect, usage and error mapping (`usage_limit` -> 429), latency instrumentation, `/v1/models`
   shaped to what the app reads. Contract test with the OpenAI SDK, then a real Copilot app session.
   **First useful milestone.** How to make the Claude CLI emit a `tool_calls` turn instead of running a tool is a
   phase 0c question (own stream-json client with `--tools ""` plus the caller's tools bridged as MCP tools that
   are intercepted and never executed, or the sidecar).
3. **CLI setup wizard + `doctor` + `connect copilot`.**
4. **Codex driver** (app-server). Second, very different protocol; likely the best latency profile
   (one process, many threads), so it also tests the warm-path numbers.
5. **Responses API** over the same item stream: typed SSE events, reasoning/message items,
   `previous_response_id`, retrieve/delete/cancel.
6. **ACP adapter** + Cursor/Grok/Antigravity flavors + registry-driven instances.
7. **Approve-in-chat**, images, structured output, concurrency limits/queueing, usage/limits on
   `/v1/providers`, OpenCode and Pi, service mode.
8. **Agent mode and hybrid tool bridging** (moved down from phase 2 once the capture decided model mode for
   Copilot): `mode = agent` with runtime modes, declined-approval reporting, activity rendering (section 5, item 3),
   conversation identity (session-folder uuid, prefix fingerprint fallback), cwd resolution from the system prompt's
   `Current working directory:` line with allowed roots, native session resume; and exposing selected client tools
   to a native agent through an MCP bridge. Optional `/v1/messages` front end. Serves plain OpenAI clients; the
   adapter already has both faces, so this is wiring plus the safety tests in section 9.

Each phase ends runnable and tested.

## 8a. Capture server (`conduit capture`)

A small, standalone OpenAI-compatible logger. It has no provider code and is the very first thing to
build, because it turns the unknowns about the Copilot app into recorded facts.

- **Listens** on a configurable port (default loopback). Any key is accepted. Optional `--lan` for a
  remote device, which requires `--key`.
- **Routes** (all logged, including 404s so we learn which endpoints the app probes):
  `GET /v1/models`, `POST /v1/chat/completions` (stream and non-stream), `POST /v1/responses` (stream
  and non-stream), `POST /v1/messages` (Anthropic-style), `GET /v1/models/{id}`, anything else.
- **Logs** each request as one JSON line under `./captures/<timestamp>.jsonl`: method, path, query,
  headers (Authorization redacted, but presence and scheme noted), the raw body, and derived facts:
  wire format, `stream`, `stream_options`, number and shape of `tools`, `tool_choice`, `reasoning`
  fields, message roles and content part types (images?), whether any session-like id appears
  (headers, `user`, `metadata`, `previous_response_id`), and any filesystem paths found in the system
  prompt or messages (the worktree question). Also logs client behavior: time to first byte read,
  time to disconnect, whether it reconnects or retries.
- **Responds** according to a selectable **scenario** (CLI flag, or a `?scenario=` / model-name suffix so
  the app's UI can switch without restarting):
  1. `text`: short plain streamed answer (baseline; proves the wire format works).
  2. `slow`: long stream with pauses between chunks and optional SSE keep-alive comments, to find the
     app's idle timeout and whether keep-alives help.
  3. `progress`: assistant text containing markdown activity lines ("ran `npm test`"), to see how the
     app renders long progress output.
  4. `reasoning`: reasoning deltas in each plausible shape (`reasoning_content`, Responses reasoning
     summary events), to see which the app displays.
  5. `toolcall`: the model asks to call one of the tools the app offered (first listed, bogus args), to
     see how the app reacts, retries, and what it sends back.
  6. `error`: HTTP 429/500 and mid-stream failure, to see error rendering.
  7. `echo`: returns a summary of what it received (so the finding is visible in the app's UI itself).
- **`/v1/models`** is configurable (ids, `context_length`, a capability blob in the common
  shapes) because the app reportedly needs a >=128k context window and tool-calling capability.
- Output: a short `capture report` command that summarizes the JSONL into the answers to section 11's
  open questions.

## 9. Testing

- Replay fixtures, as in t3code: recorded provider transcripts replayed through the real adapter and
  translators. Scenarios: simple, multi_turn (fingerprint resume), history rewritten (fingerprint miss),
  tool activity rendering, declined approval, interrupt (including right after send), failure, usage
  limit, process exit mid-turn.
- Fake provider for translator/HTTP tests (no processes).
- Wire-contract tests: the official OpenAI SDK pointed at the server. Golden SSE traces.
- **Safety tests:** cwd outside `allowed-roots` is rejected, `..` and symlink escapes included; a
  non-loopback bind without a key refuses to start; runtime mode cannot be widened by a request;
  declined approvals really stop the action (against a fixture that tries to write a marker file).
- **Latency tests:** instrumented timings (receive -> first byte -> prompt delivered) asserted against the
  budget on warm sessions, against the fake provider and against live runtimes.
- Gated live tests against real binaries (skipped in CI), plus a manual Copilot-app checklist.
- Process hygiene: no orphan children after cancel, disconnect, idle reap or shutdown.

## 10. Risks

- **Nested agent loops.** Copilot's own agent harness sits above ours. It may retry, re-plan or "fix"
  the inner agent's output, send its own tool list the model never uses, or hold assumptions about tool
  calls. Behavior is only knowable by trying it (phase 0a / phase 2). Fallback: another front end, i.e.
  any plain OpenAI chat client, where agent mode is unambiguous.
- **Conversation identity.** If the client compacts or rewrites history, the fingerprint misses and the
  agent loses its native context. Mitigated by user-message-only hashing and history replay, but
  it is heuristic. An explicit session id from the client would remove the problem; phase 0a looks for one.
- **Working directory.** If the Copilot app does not reveal its worktree path in the request, the agent
  works in a fixed workspace, which may not be the files Copilot is showing. This could weaken the
  whole integration. Phase 0a answers it.
- **Unattended execution safety.** Covered by restrictive defaults, allowed roots, bearer keys,
  loopback binding, declined approvals, and tests. Residual risk is `full-access` instances, which are
  intentionally dangerous and labeled so.
- **Latency.** Warm-session overhead should fit 250-500 ms. Cold starts will not, particularly for
  one-process-per-session runtimes. See section 5, item 3.
- **Client timeouts on long turns.** Mitigated by keep-alives and progress output; actual limits
  unknown until phase 0a.
- **Protocol drift.** Claude's `stream-json` and Codex's app-server change between releases. Pin
  tested versions, record fixtures, surface the version in `/v1/providers`.
- **Subscription / ToS.** Using a consumer subscription via a different client may be restricted by the
  provider's terms. Read each provider's current terms. Single user, loopback, and say so in the README.
- **Copilot BYOK is a preview** and its requirements (tool calling, 128k context) may change. A runtime
  that cannot advertise those capabilities may be rejected by the app regardless of what we do.
- Strict clients may choke on non-standard fields. Keep extensions namespaced and opt-in.

## 11. Decisions and open questions

Settled with the user:
- "Desktop applications" = local agent CLIs/runtimes, as in t3code.
- Provider order: Claude, then Codex, then ACP (Cursor/Grok).
- Config format: **HOCON**. Delivery: **CLI** with interactive setup menus.
- Consumer: the GitHub Copilot desktop app via BYOK.
- Latency: **250-500 ms of proxy overhead** (not end-to-end time to first token), on warm sessions.
- .NET 10 (LTS), SQLite for the session table, own Claude stream-json client (sidecar as fallback).
- **First build step is the capture/logger server (8a)**, to learn what the Copilot app sends.
- **Model mode is the default for Copilot; agent mode is opt-in (phase 8)**, decided 2026-10-17 from the capture.

### Capture findings (2026-10-17, first run: 6 completion requests, scenarios echo/progress/reasoning/toolcall)

Recorded facts about the Copilot desktop app's custom endpoint (BYOK "Custom endpoint" under Settings > Model providers):
- **Wire format: Chat Completions, streaming.** Every request was `POST /v1/chat/completions` with
  `stream: true`, `stream_options: {include_usage: true}`, `temperature: 0`, `top_p: 0.95`, zero penalties. No
  Responses or `/v1/messages` calls, no unknown paths. Client is the OpenAI JS SDK (`OpenAI/JS 5.20.1`, 600 s
  timeout, retry count 0). So phase 2 (Chat Completions first) is confirmed; Responses is not needed for Copilot.
- **Model discovery:** the app fetches `/v1/models` (no auth header) and its model catalog dialog lists the ids from
  it ("Refresh catalog"). The user adds models one by one. No `reasoning`/effort field was sent.
- **Auth:** no `Authorization` header was presented with the key left blank. Whether it sends one when a key is set
  is untested (the server accepts anything).
- **The app always sends its own tools:** 48 to 51 `function` tools per request (`bash`, `view`, `edit`, `grep`,
  `glob`, `task`, `web_fetch`, GitHub/session/project tools, ...), `tool_choice` never set, plus a 36-39 KB system
  prompt and a `<system_reminder>` user message about deferred tools.
- **Tool calls are executed by the app.** A `tool_calls` reply for `bash` made the app run it, return the error
  (`Invalid input: "command": Required`) as a `role: tool` message, and immediately POST again (`x-initiator: agent`)
  expecting the model to continue. Real tool calls from us would therefore be run by Copilot. This is the nested
  loop from section 1: in agent mode we must never emit `tool_calls` for the inner agent's own tools.
- **History:** the full history is resent each turn (3 messages, then 5 after the tool round trip).
- **Working directory is in the system prompt**, one line: `* Current working directory: <path>` followed by
  `* Git repository root: <path | Not a git repository>`. A repo session gave `/home/kevin/code/personal/api-wrapper`;
  a plain chat gave a scratch dir `/home/kevin/.copilot/chats/<date>/<slug>-<id8>`. The system prompt also names many
  *other* sessions' paths (`session-state/<uuid>`, an example `/owner/repo/pull/1234`), so extraction must match
  that exact line, not any path.
- **Conversation identity: an id exists, but only in the prompt.** No session header or body field. The system
  prompt carries `Session folder: /home/kevin/.copilot/session-state/<uuid>` (stable per session, differs between
  sessions; the `<id8>` suffix of a chat's scratch dir equals the start of that uuid). Headers `x-initiator`
  (`user` | `agent`) and `x-interaction-type` (`conversation-user`, absent on the tool-result continuation) say what
  kind of turn it is, not which conversation. Use the session-folder uuid as the primary key, prefix fingerprint as
  the fallback. Still to confirm across several turns of one chat.
- **From the app's own logs (`~/.copilot/logs/process-*.log`):** each Copilot session spawns its own Copilot CLI
  process (`session_cli_pid`) which runs the agent loop, so the "harness" above is the CLI, one per session. The
  `session_id=<uuid>` in those logs equals the `session-state/<uuid>` in the system prompt, which confirms that uuid
  is the app's real session id. Internally the model is `<provider-uuid>/capture@echo`; on the wire it is the bare
  id from `/v1/models`. The model picker reported `reasoning-effort-hidden: missing-effort-metadata`
  (`effortLevelCount: 0`, `hasContextWindowMetadata: false`), so the app did **not** read our advertised
  `context_length` / capability blob and shows no reasoning-effort control; what shape it wants is unknown (look at the
  Copilot CLI's BYOK model schema before the real `/v1/models`).
- **Agent vs. model mode:** the app is a full agent harness (its own tools, shell, cwd, sessions), which supports
  the lean toward model mode as the Copilot default. See decision 1 below.

Still untested (need the matching scenario, and for some a look at the app): `slow` / `slow-nokeepalive` (idle
timeout, whether keep-alives help), the three `error-*` scenarios (rendering, retries), how `progress` markdown and
the `reasoning` shapes render, behavior when an API key is set and when `--key` is wrong, non-streaming use,
whether the app sends more than one conversation's worth of requests at once (title/summary calls were not seen).

Decided from the capture (decision 1 confirmed by the user 2026-10-17; 2 and 3 follow directly from the data):
1. **Model mode is the default for Copilot** (was "undecided"). Copilot brings 48+ tools and executes tool calls
   itself, so the coherent fit is the runtime as an inference engine with the caller's tools exposed as `tool_calls`.
   Agent mode stays a per-instance setting for plain chat clients, and the adapter still exposes both faces as
   t3code does. **Consequence, applied in section 8: phase 2 is now model mode on Claude; the agent-mode scope moved
   to phase 8.** Revisit only if the `progress`/`reasoning` renders show that agent-mode activity text is usable in
   the app.
2. **Working directory:** parse the `Current working directory:` line from the system prompt (section 5, working
   directory), enforce `allowed-roots`. Only matters in agent mode.
3. **Conversation identity:** `Session folder` uuid from the system prompt first, prefix fingerprint second.

Still undecided:
- Whether unattended approvals should be declined (default) or answered in chat (phase 7). Only agent mode.
- Model mode details now that it is the default: how the 48+ tool schemas map onto each runtime (Claude CLI with
  `--tools ""` and caller tools bridged through an MCP shim; Codex dynamic tools; ACP), and the cost of a 36-39 KB
  system prompt on every turn.
