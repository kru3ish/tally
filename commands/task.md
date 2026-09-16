---
description: Link a task (GitHub issue URL, Jira/Linear URL, .md path, or plain text) to this session and freeze its acceptance criteria
argument-hint: <url|path|text>
allowed-tools: Bash(node *)
---

Link the task to this Tally session:

```!
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" task "$ARGUMENTS" --session "$CLAUDE_SESSION_ID" --plain
```

Report the frozen acceptance criteria, the spec-quality score, and the effort and budget estimate to the user. If the spec-quality score is below 5, list the clarifying questions and recommend clarifying the ticket before building.
