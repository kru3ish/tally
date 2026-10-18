---
description: Cost check for this story — estimate from similar past stories vs actual, where the money went, and one-line fixes
allowed-tools: Bash(node *)
---

```!
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" cost --plugin
```

Show the cost check above to the user as it is (keep the numbers and the `tally fix` lines exact). Then, in one or two sentences, say which single fix you would apply first and why. If the user asks you to apply one, run `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" fix <id>` and report what it changed.
