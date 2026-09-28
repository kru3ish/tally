---
description: Tell Tally whether a criterion's status on this session's receipt was correct, wrong or unsure; stored locally next to the receipt
argument-hint: <c2> <correct|wrong|unsure> [comment]
allowed-tools: Bash(node *)
---

```!
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" feedback --from-args "$ARGUMENTS" --plain
```

Report the line above to the user. If the label was `wrong` on a VERIFIED criterion, tell them `tally feedback wrong <c#> --report` builds a sanitized report they can file as an issue.
