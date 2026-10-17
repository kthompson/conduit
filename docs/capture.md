# Capture server (`conduit capture`)

Phase 0a from PLAN.md section 8a: a logging, OpenAI-compatible endpoint with no provider code. Point the Copilot app at
it and it records exactly what the app sends and how it reacts to different replies.

## Run

```
dotnet run --project src/Conduit.Cli -- capture                     # 127.0.0.1:8788, scenario "text"
dotnet run --project src/Conduit.Cli -- capture --scenario progress
dotnet run --project src/Conduit.Cli -- capture --lan --key secret  # reachable from another device
```

In the app, use `http://127.0.0.1:8788/v1` as the endpoint, any API key (unless `--key`), and a model id from
`/v1/models`. Requests are written to `captures/<timestamp>.jsonl`; Serilog writes the console output and
`captures/capture-<date>.log`. Paths without `/v1` (for example `/chat/completions`) are routed too.

## Switching scenarios without a restart

Per request, in order: `?scenario=`, header `X-Capture-Scenario`, a model id suffix, then `--scenario`.
`/v1/models` advertises `capture@<scenario>` ids so the app's model picker can switch:

| scenario | what it does |
|---|---|
| `text` | short plain streamed answer (baseline) |
| `slow`, `slow-nokeepalive` | `--slow-chunks` chunks, `--slow-pause` seconds apart (default 6 x 30 s), with or without SSE keep-alive comments |
| `progress` | markdown activity lines, a code block, a quote and a table in one turn |
| `reasoning` | reasoning in every plausible shape for the wire format, labelled so you can see which one renders |
| `toolcall` | calls the first tool the app offered with bogus arguments; when the result comes back, quotes it |
| `error`, `error-429`, `error-500`, `error-mid` | 429 with Retry-After, 500, or a failure mid-stream; plain `error` cycles through them |
| `echo` | replies with what it received (wire, tools, ids, paths) |

All three wire formats are implemented, streaming and not: Chat Completions, Responses, and Anthropic-style `/v1/messages`.

## What gets logged

One JSON line per request: method, path, query, headers (secrets redacted, auth presence and scheme noted), the raw
body, and a `derived` block: wire format, `stream`/`stream_options`, tool count and names, `tool_choice`, reasoning
fields, message roles and content part types, images, session-like ids (headers, `user`, `metadata`,
`previous_response_id`, ...), and filesystem paths found anywhere in the body (worktree question). The `response`
block has timings, whether the client hung up and when, and bytes/keep-alives sent. Identical repeated bodies are
flagged (`duplicateOfSeq`), which shows retries.

Handy: `jq '.body | fromjson' captures/*.jsonl`.

## Report

```
conduit capture report            # newest file in ./captures
conduit capture report --all --out report.md
```

Summarizes the log into answers to PLAN.md section 11: agent vs. model mode evidence, cwd, conversation identity,
timeouts, retries, reaction to tool calls. Things only visible in the app UI are listed for you to check by hand.

## Notes and limits

- "Time to first byte" is measured on the server (first byte written). Kestrel has no signal for when the client reads it.
- `zstd` request bodies are stored as base64 (undecoded); gzip, deflate and brotli are decoded.
- Do not use `--lan` on an untrusted network: the key is the only protection, and bodies (including prompts) are logged.
