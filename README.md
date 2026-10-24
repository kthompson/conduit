# conduit

An OpenAI-compatible endpoint backed by your agent subscription. Point a harness you like
(GitHub Copilot, or anything that speaks Chat Completions) at conduit, and Claude answers
through your Claude Code login.

```
harness ──/v1/chat/completions──▶ conduit ──Agent SDK──▶ Claude Code (your login) ──▶ Claude
   ▲                                  │
   └──────── tool_calls / results ◀───┘
```

Claude acts as a **model** here, not an agent. Claude Code's built-in tools are turned off.
The harness's tools are exposed to Claude through an in-process MCP server, and every
tool call goes back to the harness as an ordinary `tool_calls` response for it to run.

## Quick start

```bash
pnpm install
node src/cli.ts doctor        # Claude Code reachable? Which login and models?
node src/cli.ts serve         # http://127.0.0.1:4100
```

Requires Node 24+ (conduit runs its TypeScript directly) and a Claude Code login: run
`claude` once and sign in.

```bash
curl -N http://127.0.0.1:4100/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"claude-sonnet-5-5","stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

## Using it from GitHub Copilot

Copilot CLI (and the runtime built on its SDK) reads its BYOK provider from the environment:

```bash
export COPILOT_PROVIDER_BASE_URL=http://127.0.0.1:4100
export COPILOT_MODEL=claude-opus-5-5
export COPILOT_PROVIDER_API_KEY=anything   # must match server.api_key, if set
copilot
```

conduit serves both `/v1/chat/completions` and `/chat/completions`, so the base URL can
carry `/v1` or not. For other surfaces, such as Copilot Desktop, run `conduit capture` first
(below) to see exactly what the client sends.

## Commands

| Command           | What it does                                                |
| ----------------- | ----------------------------------------------------------- |
| `conduit serve`   | Serve Chat Completions backed by Claude Code                |
| `conduit capture` | Serve the **mock** model and record every exchange to JSON  |
| `conduit models`  | List the models your login can use                          |
| `conduit doctor`  | Check Claude Code, auth source and models                   |
| `conduit init`    | Write the example config to `~/.config/conduit/config.toml` |

Flags: `-c/--config`, `-p/--port`, `-H/--host`, `--provider claude|mock`, `--capture [dir]`, `-v`.

### Capture and test mode

`conduit capture` swaps Claude for a mock model and writes one JSON file per HTTP
exchange, holding the request (secrets redacted), the response chunks, and timing. Point
a harness at it to learn its wire behavior for free. Requests to routes conduit does not
implement are recorded too, so you can see what a client probes for.

The mock reports what it received (roles, system prompt size, tools, params). Send
`/tool <name> {json}` to make it call one of the harness's tools, and it reports the
results that come back.

`conduit serve --capture` records real Claude traffic the same way, and adds the raw
Agent SDK messages under `upstream`.

Captures go to `~/.local/state/conduit/captures/<timestamp>/` by default.

## Models and effort

- `/v1/models` lists what your login offers, asked live from Claude Code.
- Any id Claude Code accepts works: full ids (`claude-opus-5-5`) or aliases (`opus`, `sonnet`, `haiku`).
- Effort comes from `reasoning_effort` on the request, a `:effort` suffix on the model
  (`claude-opus-5-5:high`, handy when the harness only lets you set a model name), or
  `providers.claude.effort`.
- Thinking streams as `reasoning_content` by default. Set `reasoning = "think_tags"` or `"none"` to change that.

## How conversations map onto Claude Code

Chat Completions is stateless, but a Claude Code process is not. conduit keeps one live
process per conversation and recognizes each new request as a continuation of it:

- **Tool round trip.** When Claude calls a harness tool, conduit ends the HTTP response
  with `finish_reason: "tool_calls"` while Claude Code waits inside the MCP call. The next
  request carries the `tool` results. conduit matches them by `tool_call_id` (Claude's own
  `toolu_…` id) and Claude continues in the same process, with the prompt cache warm.
- **Follow-up turn.** When a request's history extends a session's, only the new user
  message is sent.
- **Anything else** (a restart, a model switch, edited history) starts a fresh process.
  The earlier history is resumed as real turns (user text, assistant text, `tool_use` and
  `tool_result` blocks), so the conversation carries on and a restarted server picks up where
  it left off. Thinking is not replayed.

A session is identified by system prompt, tool set, model and effort. Sessions close
after `session_idle_seconds`, and a client that disconnects mid-turn closes its session.

## Config

TOML, looked up at `--config`, then `$CONDUIT_CONFIG`, then `./conduit.toml`, then
`~/.config/conduit/config.toml`. See [conduit.example.toml](conduit.example.toml).
By default Claude runs isolated (`setting_sources = []`), so your CLAUDE.md, hooks,
plugins and MCP servers stay out of the model. `ANTHROPIC_API_KEY` is removed from Claude
Code's environment so usage goes to the subscription.

## Development

```bash
pnpm test                          # unit + mock-server tests (no Claude calls)
pnpm typecheck
node scripts/e2e.ts http://127.0.0.1:4100/v1   # live tool round trip against a running server (uses your quota)
```

Layout:

- `src/server.ts`: HTTP routing, auth, model routing
- `src/openai/`: Chat Completions wire types and SSE/JSON output
- `src/providers/claude/`: sessions (`session.ts`), tool bridge (`toolBridge.ts`), and request matching plus cold start (`provider.ts`, `conversation.ts`)
- `src/providers/mock/`: the capture-mode model
- `src/capture/`: the JSON recorder

The Claude integration follows patterns from t3code's Claude adapter (`reference/t3code`):
how it drives the Agent SDK's `query()` with streaming input, isolates settings, and handles
the auth environment. It is not a copy of that adapter. t3code's adapter is built on Effect
and its own orchestration layer, which is more machinery than a stateless HTTP front needs.

## Terms

conduit drives your own Claude Code install for your own use. Anthropic's terms restrict
offering Claude.ai logins or subscription limits through third-party products, so don't
expose a conduit instance to other people.

## Configure GitHub Copilot Desktop

`conduit setup copilot` registers conduit's models in Copilot Desktop's custom-model settings, including max prompt/output tokens, so sessions compact at the right size.

```sh
conduit setup copilot            # dry run: prints what would change
conduit setup copilot --write    # backs up ~/.copilot/data.db, then upserts a "Conduit" provider and its models
```

Setup probes each model with one tiny turn to read its real context window and output cap (`--no-probe` skips this and uses built-in defaults). Each model's supported reasoning efforts (`low`, `medium`, `high`, `xhigh`, `max`, as reported by Claude Code) are written too, as a JSON array in `supported_reasoning_efforts`; pass `--no-efforts` to leave that column alone. A model with no efforts keeps whatever you set in Copilot's form. Quit Copilot Desktop before `--write`, and restart it afterwards. Context windows and output limits come from, in order: limits the running server learned from real turns on your login, then a built-in table of values measured through Claude Code (`src/providers/claude/limits.ts`). Claude Code's limits can differ from the API docs and from plan to plan, for example Opus 4.6 and Sonnet 4.6 stay at 200K without a `[1m]` suffix, so running `setup copilot` while `conduit serve` is up (and has served a turn) gives the most accurate numbers. Restart `conduit serve` after upgrading so it picks up new defaults.
