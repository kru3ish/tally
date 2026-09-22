# r/ClaudeAI post

Fill `{{…}}` with `npx tsx scripts/fill-calibration.ts`. Flair: Built with Claude / Productivity. Attach `docs/demo.svg` or a GIF export as the image.

**Title:** I built a plugin that gives every Claude Code task a receipt: criteria frozen at the start, what shipped, what it cost, whether it held up

**Body:**

After a few months of Claude Code I could tell you my daily spend to the cent and still not answer "was that $6 task worth it?" So I built Tally.

What it does, per task:

1. **Freezes the acceptance criteria** when the session starts, from the GitHub/Jira/Linear link in your first prompt. No link? It infers the task from your prompts and commits, labels it *unconfirmed*, and the Coach asks you to confirm, edit or link with one key.
2. **Judges the result when you push.** Diff, every test command the session ran, the final message. Then it re-runs your tests itself, because a transcript saying "all tests pass" is a claim. Each criterion gets met / partial / unmet / unverifiable with the evidence line. Completion, cost by phase, waste in dollars, ROI, verdict.
3. **Follows up a week later**: merged, reverted, reopened, review churn, CI. The verdict gets adjusted.
4. **Coaches on its own** after every turn, nothing to open: same command failing 3×, same file read 3×, context at 85%, MCP server loaded but unused for 10 sessions, spend at 80% of budget. Observations reach Claude on the next prompt; things only you can decide show as flags in the status line (`/tally:statusline`).

Things people here will care about:

- **Cost of Tally itself:** the judge is tiered (mechanical checks → small model → stronger model only where a criterion could flip the verdict). On the calibration receipts it's 4.1% of the session's spend, printed on every receipt.
- **Privacy:** local only. Hooks make no network calls. Model calls go through your own `claude` login, isolated from your MCP servers and hooks. Nothing uploaded. `rm -rf ~/.tally` removes everything.
- **Accuracy, honestly:** preview. 19/19 criteria and 5/5 verdicts on five authored fixture sessions; {{CALIBRATION_CRITERION_AGREEMENT}} criterion agreement and {{CALIBRATION_VERDICT_AGREEMENT}} verdict agreement on {{CALIBRATION_SESSIONS}} of my own real sessions, blind-graded. Use it as a second opinion.
- **Doesn't replace the built-ins:** `/cost` for totals, `/insights` for the 30-day retrospective, `/plugin` Stats for what's loaded. Tally points you at them where they already do the job.

Install:

```
/plugin marketplace add kru3ish/tally
/plugin install tally@tally
npm i -g @kru3ish/tally   # CLI for the Coach pane, reports, backfill
tally doctor
```

`tally demo` replays a recorded session end to end without touching your setup, if you want to see it before installing hooks.

Repo: https://github.com/kru3ish/tally. Windows, macOS and Linux are all in CI. If you grade a few of your own sessions with `tally calibrate grade` I'd genuinely like to see where it disagrees with you.
