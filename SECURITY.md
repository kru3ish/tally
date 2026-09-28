# Security

## Reporting a vulnerability

Open a private security advisory at https://github.com/kru3ish/tally/security/advisories/new, or email the maintainer address on the npm package page (`npm view @kru3ish/tally`). Please include the Tally version (`tally --version`), the Claude Code version (`claude --version`), your OS, and steps to reproduce. You should hear back within a week; fixes ship as a patch release and are noted in `CHANGELOG.md`.

Tally is a preview maintained by one person. There is no bug bounty.

## What Tally can and cannot do on your machine

Tally runs entirely on your machine with the permissions of your user. Its moving parts:

| Part | Runs when | Reads | Writes | Network |
|---|---|---|---|---|
| Hooks (`dist/hook.js`) | on Claude Code hook events | the hook payload on stdin, `~/.tally`, `git rev-parse HEAD` | `~/.tally/sessions/<id>/events.jsonl` and friends | none |
| Judge / intake / coach model calls | `tally judge`, `tally task`, the Coach's LLM pass, the detached `finalize` after SessionEnd | Claude Code transcripts under `~/.claude/projects`, the repo's git diff, the project's test output | `~/.tally/sessions/<id>/` | `claude -p` only (your existing Claude login; no API key is stored by Tally) |
| Trackers | intake, write-back (`--post`, off by default), follow-up | GitHub via `gh`, Jira and Linear via their REST/GraphQL APIs with tokens you set in the environment | comments on the linked issue or PR, only when you opt in | those APIs |
| Independent test re-run | judge, backfill | the repo | whatever your test command writes | whatever your test command does |

Things to know:

- **Test re-runs execute your project's test command.** Tally detects it from `package.json`, `pytest`, `go test`, `cargo test`, `make test` and similar, runs it with a timeout, a scrubbed environment (no `ANTHROPIC_*`, `AWS_*`, `GITHUB_TOKEN`, `NPM_TOKEN` and the like), and kills the process group on timeout. Historical re-runs (backfill) happen in a detached `git worktree` and install dependencies only from a lockfile, offline, with scripts disabled. Re-runs are gated by a **per-repo consent** the Coach asks for once; say no and test criteria stay `unverifiable`.
- **Hooks never fail the session.** Every hook exits 0, has no network access, and finishes in well under Claude Code's budgets (the SessionEnd hook only appends one event and spawns a detached process).
- **Model calls are isolated.** `claude -p` runs with `--setting-sources ""`, `--strict-mcp-config`, no tools, no session persistence and `TALLY_INTERNAL=1`, so Tally's own calls load none of your MCP servers, hooks or skills and are never recorded as sessions.
- **Redaction before writing.** Hook events pass through a redactor (API keys, bearer and basic auth headers, `sk-`/`ghp_`/`xox`-style tokens, passwords in URLs, private key blocks) and long fields are truncated. Tool inputs keep the first 300–600 characters. The redactor is best-effort pattern matching; treat `~/.tally` like the transcripts in `~/.claude/projects` and do not commit it.
- **Settings edits are reversible.** `tally install` backs up `settings.json` first and `tally uninstall` restores it byte-identically (checked in CI). Experiments patch `.claude/settings.local.json` and restore it at session end.
- **Supply chain.** The npm package ships two bundled files with no runtime dependencies and is published from GitHub Actions with npm provenance; `npm view @kru3ish/tally --json | jq .dist.attestations` shows the attestation. The plugin form is the same repository, so `dist/` is committed and CI fails if it drifts from a fresh build.

## Privacy

See the "Privacy" section of the README for what is stored, where, and how to delete it. Precisely:

- The hooks make no network calls. Everything they record stays in `~/.tally` (or `TALLY_HOME`), redacted (keys, tokens, bearer headers, passwords in URLs) and truncated before it is written.
- Model calls leave the machine when the Judge, Coach or intake run: through `claude -p` on your own Claude login by default, or to whatever `models.base_url` you configure (OpenAI's API, or a local server for air-gapped use). What is sent: the frozen criteria, a trimmed diff and test output, tool names and truncated command lines, and the assistant's final message. Prompts are sent to intake only when a task is inferred from them; code is sent as diff hunks to the Judge. If you cannot send code to a model provider, point `models.provider` at a local endpoint.
- Tracker calls (`gh`, the Jira and Linear APIs, GitHub's REST API for issue links) happen only for the ticket you linked, and write-back to an issue or PR only with `--post` or `writeback: true`. Write-back carries statuses, cost and criteria text, never prompts or code.
- `tally export` and `tally ask` send numbers, statuses and outcomes only, and titles only with `--titles`.
- Anonymous metrics are opt-in and off by default; the allowlisted schema (version, command, success, counts, verdict word, feedback labels, a random installation id) is in `PRIVACY.md`, `tally telemetry show` prints exactly what would be sent, and `tally telemetry off` deletes the installation id.
- A wrong-verdict report (`tally feedback wrong <c#> --report`) contains statuses, evidence kinds and counts only, is scanned for secrets, is shown in full before anything is written, and opens a GitHub issue only after a separate default-No question.
- `rm -rf ~/.tally` removes everything Tally wrote; `tally uninstall` restores your settings files byte for byte from the backups it took.
