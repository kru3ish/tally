---
description: Contest a criterion on this session's receipt; the original stays next to the override and the receipt is re-scored
argument-hint: <c2> <met|partial|unmet|unverifiable> <reason>
allowed-tools: Bash(node *)
---

```!
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" dispute --from-args "$ARGUMENTS" --plain
```

Report the re-scored receipt above to the user. The dispute is recorded with their reason and feeds Tally's calibration.
