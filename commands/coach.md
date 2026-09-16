---
description: Show pending Tally Coach suggestions for this session without opening the terminal pane
allowed-tools: Bash(node *)
---

```!
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" coach --once --plain --plugin
```

Relay the suggestions above to the user, including the one-line hint about the CLI if it was printed.
