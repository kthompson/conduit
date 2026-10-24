import assert from "node:assert/strict";
import { test } from "node:test";
import { knownLimits } from "../src/providers/claude/limits.ts";
import { promptBudget } from "../src/setup-copilot.ts";

test("knows measured limits for current and legacy models", () => {
  assert.deepEqual(knownLimits("claude-opus-5-5"), { contextWindow: 1_000_000, maxOutputTokens: 128_000 });
  assert.deepEqual(knownLimits("claude-fable-5-1"), { contextWindow: 1_000_000, maxOutputTokens: 64_000 });
  assert.deepEqual(knownLimits("claude-sonnet-4-6"), { contextWindow: 200_000, maxOutputTokens: 32_000 });
  assert.equal(knownLimits("not-a-model"), undefined);
});

test("[1m] lifts the window to 1M and leaves output alone", () => {
  assert.deepEqual(knownLimits("claude-sonnet-4-6[1m]"), { contextWindow: 1_000_000, maxOutputTokens: 32_000 });
  assert.equal(knownLimits("claude-opus-5-5[1m]")?.contextWindow, 1_000_000);
});

test("copilot prompt budget is the window minus reserved output", () => {
  assert.equal(promptBudget(knownLimits("claude-opus-5-5")!), 872_000);
  assert.equal(promptBudget(knownLimits("claude-haiku-4-5-20251001")!), 168_000);
  assert.equal(promptBudget({ contextWindow: undefined, maxOutputTokens: 8000 }), null);
});
