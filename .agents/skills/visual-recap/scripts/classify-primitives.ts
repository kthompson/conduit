#!/usr/bin/env node
// Classify changed paths against docs/architecture/primitives.toml.
//   node classify-primitives.ts [--base <ref>] [--head <ref>] [--json]
//   git diff --name-only main...HEAD | node classify-primitives.ts --stdin
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { classifyPaths, loadPrimitivesMap, touchedInvariants } from "./primitives-map.ts";

const args = process.argv.slice(2);

function readFlag(name: string, fallback: string): string {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    console.error(`missing value for ${name}`);
    process.exit(1);
  }
  return value;
}

function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

const useStdin = args.includes("--stdin");
const base = readFlag("--base", "main");
const head = readFlag("--head", "HEAD");

const paths = splitLines(
  useStdin
    ? readFileSync(0, "utf8")
    : execFileSync("git", ["diff", "--name-only", `${base}...${head}`], { encoding: "utf8" }),
);
const map = loadPrimitivesMap();
const { matched, unmatched } = classifyPaths(paths, map);
const invariants = touchedInvariants(paths, map);

if (args.includes("--json")) {
  console.log(
    JSON.stringify(
      {
        base: useStdin ? null : base,
        head: useStdin ? null : head,
        pathCount: paths.length,
        matched: matched.map((m) => ({
          id: m.primitive.id,
          name: m.primitive.name,
          group: m.primitive.group,
          root: m.root,
          files: m.files,
        })),
        invariants: invariants.map((i) => ({ id: i.id, summary: i.summary })),
        unmatched,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

if (paths.length === 0) {
  console.log("No changed paths.");
  process.exit(0);
}

console.log(`Classified ${paths.length} path(s):\n`);
for (const m of matched) {
  console.log(`- ${m.primitive.id} (${m.primitive.group}) via ${m.root}`);
  for (const file of m.files.slice(0, 8)) console.log(`    ${file}`);
  if (m.files.length > 8) console.log(`    … +${m.files.length - 8} more`);
}
if (invariants.length > 0) {
  console.log("\nInvariants in the touched code:");
  for (const i of invariants) console.log(`  ${i.id}: ${i.summary}`);
}
if (unmatched.length > 0) {
  console.log(`\nUnmatched (${unmatched.length}):`);
  for (const file of unmatched.slice(0, 20)) console.log(`  ${file}`);
  if (unmatched.length > 20) console.log(`  … +${unmatched.length - 20} more`);
}
