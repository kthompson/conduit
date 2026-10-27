---
name: ship-pr
description: >
  Shepherd a pull request to done: check CI and review state, fix failures, answer
  or act on review feedback, then merge or park it. Use when a PR needs to be
  carried through to merge.
---

# Ship a PR

Loop until the PR is merged or deliberately parked. Each pass, read the state, do the
one most useful thing, and check again.

```bash
gh pr view <pr> --json state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup
gh pr checks <pr>
gh api repos/{owner}/{repo}/pulls/<pr>/comments   # inline review comments
gh pr view <pr> --comments                        # conversation comments
```

## Each pass

1. **CI red.** Read the failing job log (`gh run view <run-id> --log-failed`), reproduce
   it locally with the matching command (`pnpm test`, `pnpm typecheck`, `pnpm lint`,
   `pnpm format:check`), fix the cause, push.
2. **Review feedback.** Fix valid points. Reply on the thread saying what changed, or why
   you disagree. Do not leave comments unanswered, and do not make unrelated changes.
3. **Conflicts or behind base.** Rebase or merge `main`, rerun the checks, push.
4. **Green and handled.** Merge according to the risk below.

When the user has asked for changes to be amended into one commit, amend and
`git push --force-with-lease` instead of adding commits.

## Risk

Pick `low`, `medium`, or `high` yourself.

- **High:** changes to auth or `server.api_key` handling, secret or credential handling
  (anything touching Claude credentials or the environment passed to Claude Code),
  writes to Copilot's `data.db` (`setup-copilot.ts`), or anything hard to undo.
- **Low and medium:** merge once CI is green and valid feedback is handled.
- **High:** wait for Kevin unless he explicitly said to merge.

## Done

Before finishing, say what shipped (merged or parked, and why), and file any leftover
friction with the `file-friction` skill.
