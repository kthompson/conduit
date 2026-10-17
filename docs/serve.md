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
Tool calls are parsed tolerantly and, if a call is unusable (unknown tool, missing required argument), the model is asked once more; haiku, sonnet and opus all work (see PLAN.md section 10a).

## Model ids

`<instanceId>/<slug>`, or `<instanceId>` for the instance default. Slugs are what `claude --model` accepts (aliases or full ids).
Override the list with `config { models = [sonnet, opus] }`.

## What model mode means

The `claude` process runs with every built-in tool, MCP server, hook, skill and user setting off, in an empty scratch directory.
The caller's `tools` are described to the model in the system prompt, and a `<tool_call>` block in its reply is returned as
`tool_calls` for the caller to run. Nothing executes on this machine unless the caller runs it.

## `conduit doctor`

Checks the setup without starting the server: config, exposure (API keys, loopback), port, data directory, each instance (binary,
version, signed in) and, unless `--skip-completion`, sends a one-word prompt to each ready instance and reports the time. Exit code 1
if anything fails.

## `conduit connect copilot`

Prints what to type into the Copilot app's custom-endpoint form (display name, base URL, wire API, key, and the model ids to add).
`--check` calls the running server with your configured key and confirms it serves those models; `--show-key` prints the first key;
`--host` swaps in another address (for a LAN setup); `--json` is for scripts. It never writes the app's settings: the app keeps custom
providers in its own database and keychain and documents no config file.
