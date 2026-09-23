---
description: Ask a question over your Tally receipts (numbers only leave the machine); the answer cites the sessions it relied on
argument-hint: <question>
allowed-tools: Bash(node *)
---

```!
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" ask $ARGUMENTS
```

Show the user the answer above with the sessions it cites.
