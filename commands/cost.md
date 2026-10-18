---
description: Cost check for this story — estimate vs actual, and a short numbered list of changes for next time, each one command (opens the page too)
allowed-tools: Bash(node *)
---

```!
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" cost --open --plugin
```

Show the user the first lines (cost, estimate, result) and the numbered "Next time" list exactly as printed, keeping every number and command. Then ask which ones to apply, by number or "all". When they answer, run `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" fix <id>` for each (the id is the word after `fix` in the printed command; `fix all` applies every change Tally writes itself). For a line that is a `claude plugin install …@claude-plugins-official` command, `fix <id>` installs it. Never run a community tool's install or a removal command without the user saying so for that line.
