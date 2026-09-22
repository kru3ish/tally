---
description: Lift a Tally hard stop (repo policy budget exceeded) after a human decision
argument-hint: [reason]
allowed-tools: Bash(node *)
---

Ask the user to confirm they want to continue past the repo policy budget, then run:

```!
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" budget status
```

If the user confirms, run `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" budget approve --note "$ARGUMENTS"` with the Bash tool and tell them tool calls are allowed again.
