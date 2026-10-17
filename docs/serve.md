# Running Conduit (`conduit serve`)

An OpenAI-compatible server over the provider instances in a HOCON config. Today: Claude in model mode (`driver = claudeAgent`)
and a scripted `fake` driver for tests.

## Setup

1. Sign the Claude CLI in once: `claude auth login` (`claude auth status` should say `loggedIn: true`).
2. Write `~/.config/conduit/conduit.conf` (or pass `--config`):

```hocon
server {
  listen = "127.0.0.1:8787"
  api-keys = [ ${?CONDUIT_KEY} ]   # optional on loopback, required on any other address
}
provider-instances {
  claude { driver = claudeAgent, mode = model }
}
```

Files in `instances.d/*.conf` beside it are merged in. `conduit config validate` checks the result, `conduit config show` prints it.

3. `conduit serve` (add `-v` for debug logs, including each final assistant message).

## Use with the GitHub Copilot app

Settings, Model providers, Add provider, Custom endpoint: base URL `http://127.0.0.1:8787/v1`, wire API `completions`, key blank
(or the key you set). Use the sync icon to list `claude/sonnet`, `claude/opus`, `claude/haiku` and add the ones you want.
Prefer sonnet or opus: haiku is unreliable at the tool-call protocol (see PLAN.md section 10a).

## Model ids

`<instanceId>/<slug>`, or `<instanceId>` for the instance default. Slugs are what `claude --model` accepts (aliases or full ids).
Override the list with `config { models = [sonnet, opus] }`.

## What model mode means

The `claude` process runs with every built-in tool, MCP server, hook, skill and user setting off, in an empty scratch directory.
The caller's `tools` are described to the model in the system prompt, and a `<tool_call>` block in its reply is returned as
`tool_calls` for the caller to run. Nothing executes on this machine unless the caller runs it.
