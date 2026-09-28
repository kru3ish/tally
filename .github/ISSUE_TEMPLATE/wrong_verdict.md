---
name: Wrong verdict
about: Tally said VERIFIED, SUPPORTED, UNVERIFIED or UNMET and reality disagreed. A wrong VERIFIED is the most important bug Tally can have.
title: 'Wrong verdict: '
labels: wrong-verdict
assignees: ''
---

**The sanitized report** (from `tally feedback wrong <c#> --report`, or paste the `--out bug.json` file; it contains statuses, evidence kinds and counts, never your code, prompts, diff, paths or repository name)

```json
paste here
```

**What was actually true** (your words; no need to paste code)

**Was this a wrong VERIFIED?** yes / no  (if yes, the report already carries the `false-verified` label; that is the class fixed first)

**Anything else** (agent, model, unusual test setup, a monorepo, a red suite at the base commit)

Versions, if not in the report: `tally --version`, `claude --version`, OS.
