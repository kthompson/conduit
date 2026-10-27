#!/usr/bin/env node
// Validate docs/architecture/primitives.toml: unique ids, short single-line summaries,
// and every code/docs path resolving on disk.
import { checkPrimitivesMapPaths, defaultMapPath, loadPrimitivesMap } from "./primitives-map.ts";

const maxSummaryLength = 120;
const map = loadPrimitivesMap();
const errors: string[] = [];

for (const [kind, entries] of [
  ["primitive", map.primitives],
  ["invariant", map.invariants],
] as const) {
  const ids = new Set<string>();
  for (const e of entries) {
    if (ids.has(e.id)) errors.push(`duplicate ${kind} id: ${e.id}`);
    ids.add(e.id);
    if (kind === "primitive" && !e.name.trim()) errors.push(`primitive ${e.id} missing name`);
    if (kind === "primitive" && !map.groups.some((g) => g.id === e.group)) {
      errors.push(`primitive ${e.id} has unknown group "${e.group}"`);
    }
    if (!e.summary?.trim()) errors.push(`${kind} ${e.id} missing summary`);
    else if (e.summary.length > maxSummaryLength) {
      errors.push(`${kind} ${e.id} summary is ${e.summary.length} chars (max ${maxSummaryLength})`);
    }
  }
}
errors.push(...checkPrimitivesMapPaths(map));

if (errors.length > 0) {
  console.error(`primitives map check failed (${defaultMapPath}):`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log(
  `primitives map ok: ${map.primitives.length} primitives, ${map.invariants.length} invariants`,
);
