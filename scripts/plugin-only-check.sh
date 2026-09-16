#!/usr/bin/env bash
# The plugin-only path, end to end, with no global `tally` on PATH:
#   1. the real Claude Code plugin manager adds this checkout as a marketplace and installs tally@tally
#   2. a scratch git repo gets one file edit, delivered through the installed plugin's hooks.json exactly as
#      Claude Code would deliver it (command + args from the manifest, ${CLAUDE_PLUGIN_ROOT} substituted)
#   3. the bodies of commands/task.md, judge.md, report.md and coach.md run as the slash commands would run them
# Model calls go to scripts/fake-claude.mjs (TALLY_CLAUDE_BIN), so this needs no login and spends nothing.
# Usage: bash scripts/plugin-only-check.sh        (CI runs it on ubuntu; it also runs in Git Bash on Windows)
set -euo pipefail
# node needs native paths; Git Bash on Windows hands out /c/... and /tmp/..., so convert with cygpath where it exists
np() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
ROOT="$(np "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)")"
VERSION="$(cd "$ROOT" && node -p "require('./package.json').version")"
export CLAUDE_CONFIG_DIR="$(np "$(mktemp -d)")" TALLY_HOME="$(np "$(mktemp -d)")"
export TALLY_CLAUDE_BIN="$ROOT/scripts/fake-claude.mjs"
REPO="$(np "$(mktemp -d)")"
cleanup() { claude plugin uninstall tally@tally >/dev/null 2>&1 || true; rm -rf "$CLAUDE_CONFIG_DIR" "$TALLY_HOME" "$REPO"; }
trap cleanup EXIT

if command -v tally >/dev/null 2>&1; then echo "FAIL: a global tally is on PATH ($(command -v tally)); this check must run without the npm CLI"; exit 1; fi
echo "no global tally on PATH: ok"

# 1. marketplace + install with the real plugin manager, from this checkout
claude plugin marketplace add "$ROOT"
claude plugin install tally@tally
claude plugin list | tee /tmp/plugin-list.txt
grep -q "enabled" /tmp/plugin-list.txt || { echo "FAIL: plugin not enabled"; exit 1; }
PLUGIN_ROOT="$CLAUDE_CONFIG_DIR/plugins/cache/tally/tally/$VERSION"
test -f "$PLUGIN_ROOT/dist/hook.js" -a -f "$PLUGIN_ROOT/dist/cli.js" -a -f "$PLUGIN_ROOT/hooks/hooks.json" || { echo "FAIL: installed plugin is missing dist/ or hooks/"; ls "$PLUGIN_ROOT"; exit 1; }
echo "installed at $PLUGIN_ROOT"

# 2. scratch repo, a session id, and a transcript Claude Code would have written
git -C "$REPO" init -q -b main
git -C "$REPO" -c user.email=ci@tally.local -c user.name=ci commit -q --allow-empty -m init
printf '# scratch\n' > "$REPO/README.md"
git -C "$REPO" add -A && git -C "$REPO" -c user.email=ci@tally.local -c user.name=ci commit -q -m "add readme"
SESSION="plugin-only-$(date +%s)-4c0d-8e1a-000000000001"
TRANSCRIPT="$CLAUDE_CONFIG_DIR/projects/scratch/$SESSION.jsonl"
mkdir -p "$(dirname "$TRANSCRIPT")"
node -e "
const fs=require('fs'); const lines=fs.readFileSync(process.argv[1],'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l));
for (const l of lines) { l.sessionId=process.argv[3]; if (l.cwd) l.cwd=process.argv[4]; }
fs.writeFileSync(process.argv[2], lines.map(l=>JSON.stringify(l)).join('\n')+'\n');
" "$ROOT/test/fixtures/session-basic/transcript.jsonl" "$TRANSCRIPT" "$SESSION" "$REPO"

# deliver hook events through the installed manifest: command + args, ${CLAUDE_PLUGIN_ROOT} substituted, payload on stdin
hook() {
  local event="$1" payload="$2"
  CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" TALLY_NO_SPAWN=1 node -e "
const h=require(process.env.CLAUDE_PLUGIN_ROOT+'/hooks/hooks.json').hooks[process.argv[1]][0].hooks[0];
const {spawnSync}=require('child_process');
const args=h.args.map(a=>a.replace('\${CLAUDE_PLUGIN_ROOT}', process.env.CLAUDE_PLUGIN_ROOT));
const t0=Date.now(); const r=spawnSync(h.command,args,{input:process.argv[2],encoding:'utf8'});
process.stdout.write((r.stdout||'')+'  ['+process.argv[1]+' '+(Date.now()-t0)+' ms exit '+r.status+']\n');
if (r.status!==0) process.exit(1);
" "$event" "$payload"
}
J() { node -e "process.stdout.write(JSON.stringify(Object.assign({session_id:process.argv[1],cwd:process.argv[2],transcript_path:process.argv[3]}, JSON.parse(process.argv[4]))))" "$SESSION" "$REPO" "$TRANSCRIPT" "$1"; }
hook SessionStart "$(J '{"source":"startup","model":"fake"}')"
hook UserPromptSubmit "$(J '{"prompt":"Append the line hello-from-the-plugin-only-check to README.md"}')"
hook PreToolUse "$(J '{"tool_name":"Edit","tool_use_id":"toolu_1","tool_input":{"file_path":"'"$REPO"'/README.md","old_string":"# scratch","new_string":"# scratch\nhello-from-the-plugin-only-check"}}')"
printf 'hello-from-the-plugin-only-check\n' >> "$REPO/README.md"
hook PostToolUse "$(J '{"tool_name":"Edit","tool_use_id":"toolu_1","tool_input":{"file_path":"'"$REPO"'/README.md","old_string":"# scratch","new_string":"# scratch\nhello"},"tool_response":{"filePath":"README.md"}}')"
hook Stop "$(J '{"last_assistant_message":"Done: appended the line."}')"
test -s "$TALLY_HOME/sessions/$SESSION/events.jsonl" || { echo "FAIL: hooks recorded no events"; exit 1; }
echo "events recorded: $(wc -l < "$TALLY_HOME/sessions/$SESSION/events.jsonl")"

# 3. the slash-command bodies, exactly as commands/*.md run them
cmd() {
  local name="$1"; shift
  local body; body="$(awk '/^```!/{f=1;next} /^```/{f=0} f' "$PLUGIN_ROOT/commands/$name.md")"
  echo "--- /tally:$name"
  (cd "$REPO" && export CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" CLAUDE_SESSION_ID="$SESSION" ARGUMENTS="$*" && eval "$body")
}
cmd task "Append the line hello-from-the-plugin-only-check to README.md" | tee /tmp/task.txt
grep -q "Acceptance criteria" /tmp/task.txt || { echo "FAIL: /tally:task produced no criteria"; exit 1; }
cmd judge | tee /tmp/judge.txt
grep -q "Tally receipt" /tmp/judge.txt || { echo "FAIL: /tally:judge produced no receipt"; exit 1; }
test -f "$TALLY_HOME/sessions/$SESSION/report.md" || { echo "FAIL: report.md missing"; exit 1; }
cmd report | tee /tmp/report.txt
grep -q "1 judged task" /tmp/report.txt || { echo "FAIL: /tally:report did not count the receipt"; exit 1; }
cmd coach | tee /tmp/coach.txt
grep -q "npm i -g @kru3ish/tally" /tmp/coach.txt || { echo "FAIL: /tally:coach did not print the CLI hint"; exit 1; }
cmd tally | tee /tmp/status.txt
grep -q "npm i -g @kru3ish/tally" /tmp/status.txt || { echo "FAIL: /tally:tally did not print the CLI hint"; exit 1; }
hook SessionEnd "$(J '{"reason":"exit"}')"
echo "plugin-only check: ok"
