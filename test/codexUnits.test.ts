import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSeedItems } from "../src/providers/codex/seed.ts";
import { classifyCodexFailure, errorKind } from "../src/providers/codex/session.ts";
import { windowLabel } from "../src/providers/codex/usage.ts";
import { user } from "./fixtures/codex.ts";

test("window labels name the lengths Codex uses", () => {
  assert.equal(windowLabel(300), "5-hour session");
  assert.equal(windowLabel(10_080), "Weekly");
  assert.equal(windowLabel(43_200), "Monthly");
  assert.equal(windowLabel(2_880), "2-day window");
  assert.equal(windowLabel(90), "90-minute window");
  assert.equal(windowLabel(null), "Usage");
});

test("classifyCodexFailure separates a used-up plan from a logged-out login", () => {
  assert.deepEqual(classifyCodexFailure("usageLimitExceeded", "x", 5), {
    kind: "rate_limit",
    resetsAt: 5,
  });
  assert.equal(classifyCodexFailure("rateLimitExceeded", "x")?.kind, "rate_limit");
  assert.equal(classifyCodexFailure("unauthorized", "x")?.kind, "auth");
  assert.equal(
    classifyCodexFailure({ httpConnectionFailed: { httpStatusCode: 401 } }, "oops"),
    undefined,
  );
  assert.equal(classifyCodexFailure(undefined, "context too long"), undefined);
  assert.equal(
    errorKind({ httpConnectionFailed: { httpStatusCode: 500 } }),
    "httpConnectionFailed",
  );
  assert.equal(errorKind("other"), "other");
  assert.equal(errorKind(null), undefined);
});

test("seed items keep tool calls paired and settle calls the client never answered", () => {
  const items = buildSeedItems(
    [
      user("a"),
      {
        role: "assistant",
        content: "calling",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "lookup", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: "other tool!", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "r1" },
      user("b"),
      { role: "tool", tool_call_id: "stray", content: "late" },
    ],
    (name) => name.replaceAll("!", "_"),
  );
  assert.deepEqual(
    items.map((i) => [i.type, i.call_id ?? i.role ?? i.name]),
    [
      ["message", "user"],
      ["message", "assistant"],
      ["function_call", "c1"],
      ["function_call", "c2"],
      ["function_call_output", "c1"],
      ["function_call_output", "c2"],
      ["message", "user"],
    ],
  );
  assert.equal(items[3]?.name, "other tool_");
  assert.match(String(items[5]?.output), /did not return a result/);
});
