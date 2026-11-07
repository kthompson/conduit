import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaultConfig, loadConfig } from "../src/config.ts";

function load(toml: string) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "conduit-config-")), "conduit.toml");
  writeFileSync(file, toml);
  return loadConfig(file);
}

test("Claude is the default provider until config says otherwise", () => {
  assert.equal(defaultConfig().defaultProvider, "claude");
});

test("[providers.codex] sets the shared agent keys and the Codex-only ones", () => {
  const config = load(`
default_provider = "codex"
[providers.codex]
binary = "/opt/codex"
max_sessions = 3
effort = "high"
reasoning = "think_tags"
strip_api_key = false
tool_settle_ms = 75
[providers.codex.env]
FOO = "bar"
`);
  assert.equal(config.defaultProvider, "codex");
  assert.deepEqual(
    { ...config.codex, cwd: "" },
    {
      ...defaultConfig().codex,
      cwd: "",
      binary: "/opt/codex",
      maxSessions: 3,
      effort: "high",
      reasoning: "think_tags",
      stripApiKey: false,
      toolSettleMs: 75,
      env: { FOO: "bar" },
    },
  );
});

test("the Claude and Codex tables are independent", () => {
  const config = load(`
[providers.claude]
max_sessions = 2
[providers.codex]
max_sessions = 5
`);
  assert.equal(config.claude.maxSessions, 2);
  assert.equal(config.codex.maxSessions, 5);
});

test("a bad value names the key it came from", () => {
  assert.throws(() => load(`[providers.codex]\nreasoning = "loud"`), /providers\.codex\.reasoning/);
  assert.throws(() => load(`default_provider = "grok"`), /expected claude, codex or mock/);
});
