# TODO

- [ ] Run `conduit capture` against Copilot Desktop/CLI and record which routes, params and
      message shapes it uses (system prompt stability, `reasoning_effort`, tool_choice, extra fields)
- [ ] `/v1/responses` front end (Copilot's `wireApi: "responses"`)
- [ ] `/v1/messages` (Anthropic Messages) front end. Copilot also has an `anthropic` provider
      type, which would carry thinking and tool_use with full fidelity
- [ ] Cold-start fidelity: seed new sessions with real turns (SDK `sessionStore`/resume) instead
      of a text transcript
- [ ] `post_turn_summary`: Claude Code runs an internal step after each turn that delays a
      follow-up arriving within ~2s; find a way to turn it off
- [ ] Map subscription rate-limit errors to HTTP 429 (non-streaming) and a clearer stream error
- [ ] Honor `tool_choice` ("none", "required", a named function)
- [ ] Build step for publishing (`node` won't strip types inside node_modules)
- [ ] More providers (Codex, Grok) behind the same `Provider` interface
