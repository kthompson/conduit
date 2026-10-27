---
name: file-friction
description: >
  File durable, recurring papercuts in this repo as GitHub issues. Use when a session
  hits friction in the code, tooling, docs, or workflow that will cost the next
  person or agent time again.
---

# File friction

**File** pain that is durable and recurring, has a clear owner, and shows a reproducible
gap (a missing flag, a misleading error, a doc that is wrong, a flaky test).

**Skip** one-off confusion, session-only nits, and anything that would not help the next
reader. If nothing meets the bar, file nothing.

## How

Search first so you don't duplicate: `gh issue list --search "<keywords>" --state all`.

```bash
gh issue create --repo kthompson/conduit \
  --title "<short, specific>" \
  --body "<what happened, how to reproduce, what you expected, where it lives>"
```

Capture: the command or request that hit it, the observed vs. expected behavior, and the
file or area that likely owns it. Related items already in `TODO.md` don't need an issue.
