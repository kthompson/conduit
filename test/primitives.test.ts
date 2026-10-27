import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkPrimitivesMapPaths,
  classifyPaths,
  headingSlugs,
  loadPrimitivesMap,
  touchedInvariants,
} from "../.agents/skills/visual-recap/scripts/primitives-map.ts";

const map = loadPrimitivesMap();

test("primitives map paths resolve on disk", () => {
  assert.deepEqual(checkPrimitivesMapPaths(map), []);
});

test("classifies paths by longest matching root", () => {
  const { matched, unmatched } = classifyPaths(
    ["src/openai/chat.ts", "src/providers/claude/seed.ts", "README.md"],
    map,
  );
  assert.deepEqual(
    matched.map((m) => m.primitive.id),
    ["history-seed", "openai-wire"],
  );
  assert.deepEqual(unmatched, ["README.md"]);
});

test("reports invariants whose code is touched", () => {
  const ids = touchedInvariants(["src/capture/recorder.ts"], map).map((i) => i.id);
  assert.deepEqual(ids, ["capture-redaction"]);
});

test("docs anchors must match a heading", () => {
  const bad = { ...map, primitives: [{ ...map.primitives[0]!, docs: ["README.md#nope"] }] };
  assert.equal(checkPrimitivesMapPaths({ ...bad, invariants: [] }).length, 1);
  assert.ok(headingSlugs("## Models and effort\n### Capture & test").has("models-and-effort"));
});
