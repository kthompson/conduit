---
name: visual-recap
description: >
  Generate and maintain a recap block in a PR description: a GitHub-rendered visual
  summary of which system primitives a change touches, how risky it is, and what
  changed, preferably as a mermaid sequence diagram. Use when creating or updating a
  non-trivial pull request, or when asked for a visual recap or PR recap.
---

# PR recap

For a non-trivial change, put one marker-delimited block in the PR description. GitHub
renders it. It does not replace reading the diff.

**Read the diff, not memory.** Every claim must be checkable against
`git diff <base>...HEAD` (plus `--stat`). Session context may explain intent only.

## Classify

Run the classifier. It maps changed files onto the primitives in
[docs/architecture/primitives.toml](../../../docs/architecture/primitives.toml) and lists
any invariants in the touched code.

```bash
node .agents/skills/visual-recap/scripts/classify-primitives.ts --base main --head HEAD --json
```

Roll up to the highest of `adds`, then `extends`, then `composes`. You choose `composes`
vs `extends` from the diff. `adds` is a new map entry.

| Rollup     | Risk   | Also                                                                               |
| ---------- | ------ | ---------------------------------------------------------------------------------- |
| `composes` | low    | Wiring and call sites only.                                                        |
| `extends`  | medium | Run the relevant tests, and a live check (`scripts/e2e.ts`) for provider changes.  |
| `adds`     | high   | Update `primitives.toml`, run `pnpm primitives:check`, and do the same live check. |

Update `primitives.toml` when the PR adds, removes, or materially reshapes a primitive
(new `id`, changed meaning, or `code` roots that must move). Don't edit `summary` for
ordinary feature work. Call out a touched invariant at every risk level. Files the
classifier leaves unmatched (docs, skills, CI) don't need an entry.

Each entry's `docs` points at the README section that describes it (`README.md#heading`). When a PR changes a primitive's behavior, update that section, and add a `docs` pointer for any new feature.

Say explicitly when a plan needs **no** change to any primitive, the lowest-risk outcome.

## Steps

1. `git diff <base>...HEAD --stat`, then read the diff and run the classifier.
2. Write the block to a scratch file following
   [references/block-format.md](./references/block-format.md).
3. `node .agents/skills/visual-recap/scripts/upsert-recap-block.ts <pr-number> <block-file>`

The script replaces the marker block or appends it, and never touches text outside the
markers. Re-run both commands after a significant push.

## Pitfalls

- The block file must start with `<!-- system-recap:start -->` and end with
  `<!-- system-recap:end -->`.
- Don't put `;` in mermaid sequence notes or messages.
- Leave a blank line after `<summary>` and around every fence, or the diagram won't render.
