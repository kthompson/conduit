# TODO

- [ ] Honor `tool_choice: "none"`. Copilot sends it with all tools listed on compaction
      requests (`x-interaction-type: conversation-compaction`); `"required"` and named
      functions were never seen
- [ ] `post_turn_summary`: Claude Code runs an internal step after each turn that delays a
      follow-up arriving within ~2s; find a way to turn it off
- [ ] Map subscription rate-limit errors to HTTP 429 (non-streaming) and a clearer stream error
- [ ] Web UI: usage history over time, per-provider model restrictions, Copilot provider type
- [ ] Build step for publishing (`node` won't strip types inside node_modules)
- [ ] More providers (Copilot, Grok) behind the same `Provider` interface. Copilot's models also
      exist on other providers (Claude and GPT ids), so `Provider.owns(model)` routing needs a
      tie-break (an explicit prefix such as `copilot/gpt-5`, or a per-model route in config)
- [ ] Codex: share one `app-server` process per login across conversations (today: one per
      conversation, like Claude)
- [ ] Codex: turn off `exec`/`wait` and the collaboration tools. They stay advertised to the model
      (contained by an empty environment and a read-only sandbox), and no config key removes them
- [ ] Codex: usage for a turn that ends in `tool_calls` reads 0; Codex reports tokens after the next model request, so the following turn carries them
- [ ] Only if a client needs it: `/v1/responses` front end (Copilot's `wireApi: "responses"`)
- [ ] Only if a client needs it: `/v1/messages` (Anthropic Messages) front end. Copilot also has
      an `anthropic` provider type, which would carry thinking and tool_use with full fidelity

## Done

- [x] Codex provider (`codex app-server`), with Claude's session pool, matching, failover and
      usage extracted into a shared core and models routed to the provider that owns them

- [x] Capture Copilot Desktop traffic (`serve --capture`). Findings:
  - Only `POST /v1/chat/completions` and `GET /v1/models`; no `/v1/responses` or `/v1/messages`
  - Always `stream: true`, `stream_options.include_usage`, `temperature: 1`,
    `reasoning_effort: "medium"`, ~76-77 tools; `max_tokens: 128000` on most
  - Assistant messages are replayed with `reasoning_content`, `refusal` and
    `__copilotMessageSource`
  - `x-initiator` (user/agent) and `x-interaction-type` (conversation-user, -subagent,
    -compaction) headers identify Copilot's internal requests
- [x] Cold-start fidelity: new sessions resume the earlier history as real turns (user text,
      assistant text, `tool_use`/`tool_result`) through the SDK `sessionStore`, so a restarted
      server picks up mid-conversation. Thinking is not replayed (signatures can't be forged)
