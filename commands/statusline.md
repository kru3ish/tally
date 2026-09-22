---
description: Put Tally in the Claude Code status line (task, spend vs budget, context, open Coach flags)
allowed-tools: Bash(node *)
---

```!
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" statusline --install --plugin
```

Tell the user what the command above reported. If it installed the status line, say they need to restart Claude Code (or start a new session) to see it, and that `/tally:statusline` can be re-run after a plugin update if the line disappears.
