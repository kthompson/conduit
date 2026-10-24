import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatMessage } from "../src/openai/types.ts";
import {
  assistantFingerprint,
  fingerprint,
  sessionKey,
  splitSystem,
  toToolResultContent,
  toUserBlocks,
} from "../src/providers/claude/conversation.ts";
import {
  coldStartBlocks,
  matchSession,
  type SessionLike,
} from "../src/providers/claude/provider.ts";

const user = (content: string): ChatMessage => ({ role: "user", content });
const calls = (...ids: string[]): ChatMessage => ({
  role: "assistant",
  content: "",
  tool_calls: ids.map((id) => ({ id, type: "function", function: { name: "f", arguments: "{}" } })),
});
const result = (id: string, content = "ok"): ChatMessage => ({
  role: "tool",
  tool_call_id: id,
  content,
});

function session(over: Partial<SessionLike> & { history: ChatMessage[] }): SessionLike {
  return {
    key: "k",
    state: "idle",
    lastUsed: 0,
    transcript: over.history.map(fingerprint),
    pendingToolIds: [],
    ...over,
  };
}

test("splitSystem takes only leading system and developer messages", () => {
  const { system, conversation } = splitSystem([
    { role: "system", content: "a" },
    { role: "developer", content: "b" },
    user("hi"),
    { role: "system", content: "late" },
  ]);
  assert.equal(system, "a\n\nb");
  assert.equal(conversation.length, 2);
});

test("fingerprints ignore whitespace and identify tool-call turns by ids", () => {
  assert.equal(fingerprint(user("hello  world\n")), fingerprint(user("hello world")));
  assert.equal(fingerprint(calls("x", "y")), assistantFingerprint("whatever text", ["x", "y"]));
  assert.equal(
    fingerprint({ role: "assistant", content: " done " }),
    assistantFingerprint("done", []),
  );
});

test("sessionKey changes with model, effort, system and tools", () => {
  const base = { system: "s", tools: [], model: "opus", effort: undefined };
  const k = sessionKey(base);
  assert.notEqual(k, sessionKey({ ...base, model: "sonnet" }));
  assert.notEqual(k, sessionKey({ ...base, effort: "high" }));
  assert.notEqual(k, sessionKey({ ...base, system: "t" }));
  assert.notEqual(
    k,
    sessionKey({ ...base, tools: [{ type: "function", function: { name: "f" } }] }),
  );
});

test("content conversion handles data-url images and unknown parts", () => {
  const blocks = toUserBlocks([
    { type: "text", text: "look" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    { type: "input_audio", input_audio: {} },
  ]);
  assert.deepEqual(blocks[1], {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "AAAA" },
  });
  assert.equal(blocks[2]!.type, "text");
  assert.deepEqual(toToolResultContent("plain"), [{ type: "text", text: "plain" }]);
});

test("a request answering pending tool calls resumes the awaiting session", () => {
  const history = [user("go"), calls("t1", "t2")];
  const s = session({ history, state: "awaiting_tools", pendingToolIds: ["t1", "t2"] });
  const conversation = [...history, result("t1", "one"), result("t2", "two")];
  const m = matchSession([s], "k", conversation, conversation.map(fingerprint));
  assert.equal(m.kind, "tools");
  assert.deepEqual(m.kind === "tools" ? m.results.map((r) => r.id) : [], ["t1", "t2"]);
});

test("user content after tool results rides on the last result", () => {
  const history = [user("go"), calls("t1")];
  const s = session({ history, state: "awaiting_tools", pendingToolIds: ["t1"] });
  const conversation = [...history, result("t1"), user("also note this")];
  const m = matchSession([s], "k", conversation, conversation.map(fingerprint));
  assert.equal(m.kind, "tools");
  if (m.kind === "tools") assert.equal(m.results[0]!.content.at(-1)?.type, "text");
});

test("a follow-up user message continues an idle session", () => {
  const history = [user("hi"), { role: "assistant", content: "hello" } as ChatMessage];
  const s = session({ history });
  const conversation = [...history, user("next")];
  const m = matchSession([s], "k", conversation, conversation.map(fingerprint));
  assert.equal(m.kind, "user");
});

test("edited history, another key, or a busy session do not match", () => {
  const history = [user("hi"), { role: "assistant", content: "hello" } as ChatMessage];
  const conversation = [
    user("hi"),
    { role: "assistant", content: "EDITED" } as ChatMessage,
    user("next"),
  ];
  const prints = conversation.map(fingerprint);
  assert.equal(matchSession([session({ history })], "k", conversation, prints).kind, "none");

  const ok = [...history, user("next")];
  const okPrints = ok.map(fingerprint);
  assert.equal(matchSession([session({ history })], "other", ok, okPrints).kind, "none");
  assert.equal(matchSession([session({ history, state: "busy" })], "k", ok, okPrints).kind, "none");
});

test("results for calls the session did not make do not match", () => {
  const history = [user("go"), calls("t1")];
  const s = session({ history, state: "awaiting_tools", pendingToolIds: ["t1"] });
  const conversation = [user("go"), calls("t1"), result("zzz")];
  assert.equal(matchSession([s], "k", conversation, conversation.map(fingerprint)).kind, "none");
});

test("cold start renders history as a transcript before the new user message", () => {
  const blocks = coldStartBlocks([
    user("first"),
    calls("t1"),
    result("t1", "42"),
    { role: "assistant", content: "it is 42" },
    user("thanks"),
  ]);
  assert.equal(blocks.length, 2);
  assert.match((blocks[0] as { text: string }).text, /\[tool result t1\]\n42/);
  assert.deepEqual(blocks[1], { type: "text", text: "thanks" });
});

test("cold start that ends on tool results asks Claude to continue", () => {
  const blocks = coldStartBlocks([user("go"), calls("t1"), result("t1")]);
  assert.match((blocks.at(-1) as { text: string }).text, /Continue/);
});
