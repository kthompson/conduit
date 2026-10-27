import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "smol-toml";

const repoRoot = resolve(import.meta.dirname, "../../../..");
export const defaultMapPath = resolve(repoRoot, "docs/architecture/primitives.toml");

export interface Entry {
  id: string;
  name: string;
  group: string;
  summary: string;
  code: string[];
  docs: string[];
}

export interface PrimitivesMap {
  version: number;
  groups: { id: string; name: string }[];
  primitives: Entry[];
  invariants: Entry[];
}

export interface Match {
  primitive: Entry;
  root: string;
  files: string[];
}

function fill(entry: Entry): Entry {
  return {
    ...entry,
    name: entry.name ?? "",
    group: entry.group ?? "",
    code: entry.code ?? [],
    docs: entry.docs ?? [],
  };
}

export function parsePrimitivesMap(text: string): PrimitivesMap {
  const raw = parse(text) as Partial<PrimitivesMap>;
  return {
    version: raw.version ?? 1,
    groups: raw.groups ?? [],
    primitives: (raw.primitives ?? []).map(fill),
    invariants: (raw.invariants ?? []).map(fill),
  };
}

export function loadPrimitivesMap(mapPath = defaultMapPath): PrimitivesMap {
  return parsePrimitivesMap(readFileSync(mapPath, "utf8"));
}

/** A root ending in "/" matches a directory; otherwise it matches that path or prefix. */
export function pathMatchesRoot(filePath: string, root: string): boolean {
  const file = filePath.replaceAll("\\", "/");
  const normalized = root.replaceAll("\\", "/").replace(/\/$/, "");
  if (!normalized) return false;
  if (root.endsWith("/")) return file === normalized || file.startsWith(`${normalized}/`);
  return file.startsWith(normalized);
}

/** Longest-prefix match: each path goes to the primitive(s) with the longest matching root. */
export function classifyPaths(
  paths: string[],
  map: PrimitivesMap,
): { matched: Match[]; unmatched: string[] } {
  const byId = new Map<string, Match>();
  const unmatched: string[] = [];

  for (const rawPath of paths) {
    const filePath = rawPath.replaceAll("\\", "/").replace(/^\.\//, "");
    if (!filePath || filePath.endsWith("/")) continue;

    const matches = map.primitives.flatMap((primitive) =>
      primitive.code
        .filter((root) => pathMatchesRoot(filePath, root))
        .map((root) => ({ primitive, root })),
    );
    if (matches.length === 0) {
      unmatched.push(filePath);
      continue;
    }

    const longest = Math.max(...matches.map((m) => m.root.length));
    for (const winner of matches.filter((m) => m.root.length === longest)) {
      const existing = byId.get(winner.primitive.id);
      if (existing) {
        if (!existing.files.includes(filePath)) existing.files.push(filePath);
      } else {
        byId.set(winner.primitive.id, { ...winner, files: [filePath] });
      }
    }
  }

  const matched = Array.from(byId.values());
  // oxlint-disable-next-line unicorn/no-array-sort -- `matched` is a fresh copy
  matched.sort((a, b) => a.primitive.id.localeCompare(b.primitive.id));
  return { matched, unmatched };
}

/** Invariants whose code roots cover any of the changed files. */
export function touchedInvariants(paths: string[], map: PrimitivesMap): Entry[] {
  return map.invariants.filter((inv) =>
    paths.some((p) => inv.code.some((root) => pathMatchesRoot(p, root))),
  );
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** GitHub-style heading anchors for a markdown file. */
export function headingSlugs(markdown: string): Set<string> {
  const slugs = new Set<string>();
  for (const match of markdown.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) {
    const heading = match[1] ?? "";
    slugs.add(
      heading
        .toLowerCase()
        .replaceAll(/[^\p{L}\p{N}\s-]/gu, "")
        .replaceAll(/\s/g, "-"),
    );
  }
  return slugs;
}

/** Every `code` and `docs` path must resolve on disk. */
export function checkPrimitivesMapPaths(map: PrimitivesMap, root = repoRoot): string[] {
  const errors: string[] = [];
  const entries = [
    ...map.primitives.map((e) => ({ kind: "primitive", e })),
    ...map.invariants.map((e) => ({ kind: "invariant", e })),
  ];
  for (const { kind, e } of entries) {
    for (const doc of e.docs) {
      const [file = "", anchor] = doc.split("#");
      const abs = resolve(root, file);
      if (!existsSync(abs) || !statSync(abs).isFile()) {
        errors.push(`${kind} ${e.id}: ${doc} (docs path missing or not a file)`);
      } else if (anchor !== undefined && !headingSlugs(readFileSync(abs, "utf8")).has(anchor)) {
        errors.push(`${kind} ${e.id}: ${doc} (no matching heading)`);
      }
    }
    for (const code of e.code) {
      if (existsSync(resolve(root, code.replace(/\/$/, "")))) continue;
      const prefix = code.split("/").at(-1) ?? "";
      const parent = resolve(root, code.split("/").slice(0, -1).join("/"));
      if (!code.endsWith("/") && readdirSafe(parent).some((name) => name.startsWith(prefix))) {
        continue;
      }
      errors.push(`${kind} ${e.id}: ${code} (code root missing on disk)`);
    }
  }
  return errors;
}
