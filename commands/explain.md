---
description: Show the evidence behind one criterion of this session's receipt (diff, test output, transcript moments)
argument-hint: <c1|all>
allowed-tools: Bash(node *)
---

```!
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" judge --explain "$ARGUMENTS" --plain
```

Show the user the explanation above. If they disagree with a status, tell them they can contest it with `/tally:dispute <criterion> <status> <reason>`.
