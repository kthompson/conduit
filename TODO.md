# TODO

- [ ] Honor `tool_choice: "none"`. Copilot sends it with all tools listed on compaction
      requests (`x-interaction-type: conversation-compaction`); `"required"` and named
      functions were never seen
- [ ] `post_turn_summary`: Claude Code runs an internal step after each turn that delays a
      follow-up arriving within ~2s; find a way to turn it off
- [ ] Map subscription rate-limit errors to HTTP 429 (non-streaming) and a clearer stream error
- [ ] Build step for publishing (`node` won't strip types inside node_modules)
- [ ] More providers (Codex, Grok) behind the same `Provider` interface
- [ ] Only if a client needs it: `/v1/responses` front end (Copilot's `wireApi: "responses"`)
- [ ] Only if a client needs it: `/v1/messages` (Anthropic Messages) front end. Copilot also has
      an `anthropic` provider type, which would carry thinking and tool_use with full fidelity

## Done

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
