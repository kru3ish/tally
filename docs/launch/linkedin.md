# LinkedIn post (0.4.0, 2026-09-27)

Plain text, no markdown on LinkedIn. About 230 words; the first two lines are what shows before "see more".

---

I spent ten days building the thing I wished Claude Code had: a receipt.

Every AI coding tool tells you what a session cost. None of them tell you what you got for it. So I built Tally: a small, local, open-source tool that freezes a task's acceptance criteria before any code exists, judges what shipped against them (it re-runs your tests itself, because "all tests pass" in a transcript is a claim), prices the waste, and checks a week later whether the PR held up.

What I learned building it, in one line: criteria and tests are not enough. When I pointed Tally at six real open-source bugs and had the fixes graded blind, it agreed with the grader on 28 of 29 criteria. The two verdicts it got wrong were fixes that met every criterion with a green suite and that a maintainer would still send back: one patched around a bug in a dependency, one silently changed behaviour no test covered. So 0.4 adds a maintainer-review tier that reads the diff the way a reviewer does, and it can only hold a verdict down, never lift it.

Also in 0.4: it now works with Codex CLI, Gemini CLI and Cursor, not just Claude Code, and any OpenAI-compatible model can be the judge.

Honest numbers: 19/19 on authored fixtures, 28/29 on real issues, and 51% criterion agreement with a human on my own messy sessions. That last one is the one that matters and it is still n=11. If you use an AI coding agent daily and would grade six of your own sessions, I would like your data more than your star.

npm i -g @kru3ish/tally
github.com/kru3ish/tally

#ClaudeCode #AIEngineering #DeveloperTools #OpenSource

---

## Notes for the author

- Do not add a screenshot of the status line without checking it for repo names you do not want public; the receipt image in the README (docs/demo.svg) is safe, it is the demo session.
- The claim to avoid: "measures ROI". Say "computes a verdict from criteria, tests and cost" if asked; the ROI figure depends on an estimated hourly value and the README says so.
- If someone asks about the 51%: the first pass was 35%, the improvement came from fixing a bias in the mechanical checks, not from re-grading. That story is more convincing than a higher number would be.
- Follow-up comment to have ready: the Codex and Cursor adapters were verified against docs, not on those tools live; first reports welcome.
