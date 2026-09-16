---
description: Run the Tally Judge on this session now and print the receipt
argument-hint: [--post]
allowed-tools: Bash(node *)
---

Run the Tally Judge for this session (independent test re-run, cost, waste, ROI, verdict):

```!
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" judge $ARGUMENTS --plain
```

Show the user the receipt summary above verbatim. Do not re-judge the work yourself; the receipt is the record.
