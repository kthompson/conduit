import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexProvider } from "../src/providers/codex/provider.ts";
import { fakeCodex, turn, user } from "./fixtures/codex.ts";

test("streams text, reasoning and usage for a plain turn", async () => {
  const { config, calls } = fakeCodex();
  const provider = new CodexProvider(config);
  try {
    const out = await turn(provider, [user("ping")], { effort: "high" });
    assert.equal(out.text, "pong");
    assert.equal(out.reasoning, "thinking");
    assert.equal(out.done?.finishReason, "stop");
    assert.deepEqual(out.done?.usage, {
      prompt_tokens: 100,
      completion_tokens: 7,
      total_tokens: 107,
      prompt_tokens_details: { cached_tokens: 40 },
    });
    const log = calls();
    assert.ok(log.includes("dynamicTools=lookup environments=[] sandbox=read-only"));
    assert.ok(log.includes("turn effort=high text=ping"));
  } finally {
    await provider.close();
  }
});

test("a tool call ends the HTTP turn; the result resumes the same live session", async () => {
  const { config, calls } = fakeCodex();
  const provider = new CodexProvider(config);
  try {
    const first = await turn(provider, [user('tool lookup {"q":"x"}')]);
    assert.equal(first.done?.finishReason, "tool_calls");
    assert.equal(first.calls.length, 1);
    assert.equal(first.calls[0]?.name, "lookup");
    assert.deepEqual(JSON.parse(first.calls[0]?.args ?? ""), { q: "x" });

    const id = first.calls[0]?.id ?? "";
    const second = await turn(provider, [
      user('tool lookup {"q":"x"}'),
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id, type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } },
        ],
      },
      { role: "tool", tool_call_id: id, content: "the answer" },
    ]);
    assert.equal(second.text, "got: the answer");
    assert.equal(second.done?.finishReason, "stop");
    assert.equal(calls().filter((c) => c === "thread/start").length, 1);
    // Usage is counted per HTTP turn from the thread's running total.
    assert.equal(second.done?.usage?.prompt_tokens, 200);
    assert.equal(second.done?.usage?.completion_tokens, 12);
  } finally {
    await provider.close();
  }
});

test("tool calls that arrive together are handed to the client as one batch", async () => {
  const { config } = fakeCodex();
  const provider = new CodexProvider(config);
  try {
    const first = await turn(provider, [user("two-tools")]);
    assert.equal(first.done?.finishReason, "tool_calls");
    assert.equal(first.calls.length, 2);
    const [a, b] = first.calls;
    const second = await turn(provider, [
      user("two-tools"),
      {
        role: "assistant",
        content: null,
        tool_calls: first.calls.map((c) => ({
          id: c.id,
          type: "function" as const,
          function: { name: c.name, arguments: c.args },
        })),
      },
      { role: "tool", tool_call_id: a?.id ?? "", content: "A" },
      { role: "tool", tool_call_id: b?.id ?? "", content: "B" },
    ]);
    assert.equal(second.text, "got: A + B");
  } finally {
    await provider.close();
  }
});

test("a later user message continues the idle session instead of starting another", async () => {
  const { config, calls } = fakeCodex();
  const provider = new CodexProvider(config);
  try {
    await turn(provider, [user("ping")]);
    const again = await turn(provider, [
      user("ping"),
      { role: "assistant", content: "pong" },
      user("ping"),
    ]);
    assert.equal(again.text, "pong");
    assert.equal(calls().filter((c) => c === "thread/start").length, 1);
  } finally {
    await provider.close();
  }
});

test("earlier history is injected as real items when a conversation starts cold", async () => {
  const { config } = fakeCodex();
  const provider = new CodexProvider(config);
  try {
    const out = await turn(provider, [
      user("hello"),
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "old", type: "function", function: { name: "lookup", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "old", content: "result" },
      { role: "assistant", content: "done" },
      user("history"),
    ]);
    assert.equal(out.text, "injected: message,function_call,function_call_output,message");
  } finally {
    await provider.close();
  }
});

test("an unsupported effort is dropped once the model's efforts are known", async () => {
  const { config, calls } = fakeCodex();
  const provider = new CodexProvider(config);
  try {
    await provider.listModels();
    await turn(provider, [user("ping")], { effort: "medium" });
    assert.ok(calls().includes("turn effort=none text=ping"));
  } finally {
    await provider.close();
  }
});

test("requests that would act on the machine are declined", async () => {
  const { config } = fakeCodex();
  const provider = new CodexProvider(config);
  try {
    const out = await turn(provider, [user("approve")]);
    assert.equal(out.text, "decision: decline");
  } finally {
    await provider.close();
  }
});

test("a used-up plan fails the turn as a rate limit with its reset time", async () => {
  const { config } = fakeCodex();
  const provider = new CodexProvider(config);
  try {
    const out = await turn(provider, [user("limit")]);
    assert.equal(out.error?.failure?.kind, "rate_limit");
    assert.equal(out.error?.failure?.resetsAt, 4_102_444_800_000);
  } finally {
    await provider.close();
  }
});

test("a client that disconnects mid-turn closes the session", async () => {
  const { config } = fakeCodex();
  const provider = new CodexProvider(config);
  try {
    const abort = new AbortController();
    const pending = turn(provider, [user("hang")], { signal: abort.signal });
    setTimeout(() => abort.abort(), 300);
    const out = await pending;
    assert.match(out.error?.message ?? "", /client disconnected/);
  } finally {
    await provider.close();
  }
});

test("a Codex process that dies fails the turn", async () => {
  const { config } = fakeCodex();
  const provider = new CodexProvider(config);
  try {
    const out = await turn(provider, [user("exit")]);
    assert.match(out.error?.message ?? "", /codex exited with code 3/);
  } finally {
    await provider.close();
  }
});

test("a missing binary is reported, not thrown", async () => {
  const { config } = fakeCodex();
  const provider = new CodexProvider({ ...config, binary: "/nonexistent/codex" });
  try {
    const out = await turn(provider, [user("ping")]);
    assert.match(out.error?.message ?? "", /could not run codex/);
  } finally {
    await provider.close();
  }
});
