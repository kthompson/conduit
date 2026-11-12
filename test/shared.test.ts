import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyFailure } from "../src/providers/failure.ts";
import { aliasFor, PendingToolCalls } from "../src/providers/pendingTools.ts";

test("a result delivered before the model asks is handed over when it does", async () => {
  const pending = new PendingToolCalls();
  pending.deliver("a", [{ type: "text", text: "early" }]);
  const result = await pending.wait("a");
  assert.deepEqual(result, { content: [{ type: "text", text: "early" }], isError: false });
});

test("a call waits until the client's result arrives", async () => {
  const pending = new PendingToolCalls();
  const waiting = pending.wait("a");
  pending.deliver("a", [{ type: "text", text: "late" }]);
  assert.equal((await waiting).content[0]?.type, "text");
});

test("cancelling answers every waiting call with an error", async () => {
  const pending = new PendingToolCalls();
  const a = pending.wait("a");
  const b = pending.wait("b");
  pending.cancelAll("closing");
  for (const r of await Promise.all([a, b])) {
    assert.equal(r.isError, true);
    assert.deepEqual(r.content, [{ type: "text", text: "closing" }]);
  }
});

test("an aborted wait resolves as cancelled and a later result is kept for nobody", async () => {
  const pending = new PendingToolCalls();
  const abort = new AbortController();
  const waiting = pending.wait("a", abort.signal);
  abort.abort();
  assert.equal((await waiting).isError, true);
});

test("tool names are made safe and short enough, keeping distinct names distinct", () => {
  assert.equal(aliasFor("get weather!"), "get_weather_");
  const long = "x".repeat(100);
  const a = aliasFor(`${long}a`, 10);
  const b = aliasFor(`${long}b`, 10);
  assert.ok(a.length + 10 <= 64);
  assert.notEqual(a, b);
});

test("failure classification honors the provider's own auth codes", () => {
  const authCodes = new Set(["billing_error"]);
  assert.equal(classifyFailure("billing_error", "x", { authCodes })?.kind, "auth");
  assert.equal(classifyFailure("billing_error", "x"), undefined);
  assert.deepEqual(classifyFailure("rate_limit", "x", { resetsAt: 9 }), {
    kind: "rate_limit",
    resetsAt: 9,
  });
});
