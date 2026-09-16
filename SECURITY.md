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

See the "Privacy" section of the README for what is stored, where, and how to delete it. In short: nothing leaves your machine except model calls through your own Claude login and the tracker calls you opt into; `rm -rf ~/.tally` removes everything Tally wrote.
