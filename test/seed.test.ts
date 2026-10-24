import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatMessage } from "../src/openai/types.ts";
import { buildSeedEntries, SeedStore } from "../src/providers/claude/seed.ts";

const build = (history: ChatMessage[]) =>
  buildSeedEntries({
    sessionId: "s1",
    cwd: "/tmp",
    model: "m",
    history,
    toolName: (n) => `mcp__tools__${n}`,
  });

type Blocks = Array<Record<string, unknown>>;
const blocksOf = (e: unknown): Blocks => (e as { message: { content: Blocks } }).message.content;

const call = (id: string): ChatMessage => ({
  role: "assistant",
  content: "looking",
  tool_calls: [{ id, type: "function", function: { name: "f", arguments: '{"a":1}' } }],
});

test("history becomes a chained user/assistant transcript with tool blocks", () => {
  const entries = build([
    { role: "user", content: "go" },
    call("t1"),
    { role: "tool", tool_call_id: "t1", content: "42" },
    { role: "assistant", content: "it is 42" },
  ]);
  assert.deepEqual(
    entries.map((e) => e.type),
    ["user", "assistant", "user", "assistant"],
  );
  assert.equal(entries[0]?.parentUuid, null);
  entries.slice(1).forEach((e, i) => assert.equal(e.parentUuid, entries[i]?.uuid));
  assert.deepEqual(blocksOf(entries[1])[1], {
    type: "tool_use",
    id: "t1",
    name: "mcp__tools__f",
    input: { a: 1 },
  });
  const [result] = blocksOf(entries[2]);
  assert.equal(result?.type, "tool_result");
  assert.equal(result?.tool_use_id, "t1");
});

test("unanswered tool calls get a synthetic error result", () => {
  const entries = build([
    { role: "user", content: "go" },
    call("t1"),
    { role: "user", content: "never mind" },
  ]);
  const content = blocksOf(entries[2]);
  assert.equal(content[0]?.type, "tool_result");
  assert.equal(content[0]?.is_error, true);
  assert.equal(content[1]?.type, "text");
});

test("the seed store serves only its own session", async () => {
  const entries = build([{ role: "user", content: "hi" }]);
  const store = new SeedStore("s1", entries);
  assert.equal(await store.load({ projectKey: "x", sessionId: "s1" }), entries);
  assert.equal(await store.load({ projectKey: "x", sessionId: "other" }), null);
});
