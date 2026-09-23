---
description: Replay a session as a timeline with the off-track moments marked (first failing test, retry loops, context pressure, compactions)
argument-hint: [session]
allowed-tools: Bash(node *)
---

```!
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" replay $ARGUMENTS
```

Show the user the timeline above and name the first moment where the session went off track.
