---
description: Apply a fix from the cost check — a setting, subagent, skill, CLAUDE.md note or official plugin (e.g. /tally:fix compact-window, /tally:fix all)
argument-hint: <fix id | all | --list>
allowed-tools: Bash(node *)
---

```!
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" fix $ARGUMENTS
```

Tell the user in one or two lines what changed and where (file or plugin), that it takes effect in the next session, and that `tally undo` (or `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" undo`) reverts a file change. If it printed commands instead of applying them, show them and ask before running any.
