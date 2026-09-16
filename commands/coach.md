---
description: Show pending Tally Coach suggestions for this session without opening the terminal pane
allowed-tools: Bash(node *)
---

```!
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" coach --session "$CLAUDE_SESSION_ID" --once --plain
```

Relay the suggestions above to the user. To act on them with one key, they can run `tally watch` in a second terminal.
