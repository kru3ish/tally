/* Tally hook entry. Hard rules: finish under 150ms, always exit 0, no network, redact before writing.
   Only node builtins + src/paths + src/redact are imported so startup stays cheap. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { activeFile, appendLine, ensureDir, historyFile, readJson, repoKey, sessionDir, tallyHome, writeJson, claudeHome } from '../paths.js';
import { redact, redactDeep } from '../redact.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'cli.js');
const SHIP_RE = /\bgit\s+push\b|\bgh\s+pr\s+(create|merge)\b|\bnpm\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b/;
const TASK_URL_RE = /https?:\/\/(github\.com\/[^\s/]+\/[^\s/]+\/(issues|pull)\/\d+|[^\s]+\.atlassian\.net\/browse\/[A-Z][A-Z0-9]+-\d+|linear\.app\/[^\s]+\/issue\/[A-Z0-9]+-\d+[^\s]*)/;
const TASK_MD_RE = /(?:^|\s)((?:[A-Za-z]:)?[^\s"']+\.md)(?=\s|$)/;
const MAX_FIELD = 2000;

interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  tool_use_id?: string;
  last_assistant_message?: string;
  trigger?: string;
  reason?: string;
  source?: string;
  model?: string;
  message?: string;
  notification_type?: string;
  error?: unknown;
  agent_id?: string;
  agent_type?: string;
}

function readStdin(): string {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function truncate(s: unknown, n = MAX_FIELD): string {
  const str = typeof s === 'string' ? s : JSON.stringify(s ?? '');
  return str.length > n ? str.slice(0, n) + `…[+${str.length - n}]` : str;
}

function nowIso(): string {
  return new Date().toISOString();
}

function record(session: string, type: string, cwd: string | undefined, data: Record<string, unknown>): void {
  const ev = { ts: nowIso(), type, session, cwd, data: redactDeep(data) };
  appendLine(path.join(sessionDir(session), 'events.jsonl'), JSON.stringify(ev));
}

function spawnDetached(args: string[]): void {
  if (process.env.TALLY_NO_SPAWN) {
    appendLine(path.join(tallyHome(), 'spawn.log'), JSON.stringify({ ts: nowIso(), args }));
    return;
  }
  try {
    const child = spawn(process.execPath, [CLI, ...args], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
    child.unref();
  } catch {
    /* never fail the hook */
  }
}

function gitHead(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  try {
    let dir = cwd;
    for (let i = 0; i < 6; i++) {
      const gitPath = path.join(dir, '.git');
      if (fs.existsSync(gitPath)) {
        let gitDir = gitPath;
        if (fs.statSync(gitPath).isFile()) {
          const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(gitPath, 'utf8'));
          if (!m) return undefined;
          gitDir = path.resolve(dir, m[1]!.trim());
        }
        const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
        const ref = /^ref:\s*(.+)$/.exec(head);
        if (!ref) return head;
        const refFile = path.join(gitDir, ref[1]!);
        if (fs.existsSync(refFile)) return fs.readFileSync(refFile, 'utf8').trim();
        const packed = path.join(gitDir, 'packed-refs');
        if (fs.existsSync(packed)) {
          for (const line of fs.readFileSync(packed, 'utf8').split('\n')) {
            const [sha, name] = line.split(' ');
            if (name === ref[1]) return sha;
          }
        }
        return undefined;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function loadedInventory(cwd: string | undefined): { mcp: string[]; skills: string[]; plugins: string[] } {
  const mcp = new Set<string>();
  const skills = new Set<string>();
  const plugins = new Set<string>();
  try {
    const home = claudeHome();
    const global = readJson<{ mcpServers?: Record<string, unknown>; projects?: Record<string, { mcpServers?: Record<string, unknown> }> }>(path.join(path.dirname(home), '.claude.json'), {});
    for (const k of Object.keys(global.mcpServers ?? {})) mcp.add(k);
    if (cwd) for (const k of Object.keys(global.projects?.[cwd]?.mcpServers ?? {})) mcp.add(k);
    if (cwd) {
      const proj = readJson<{ mcpServers?: Record<string, unknown> }>(path.join(cwd, '.mcp.json'), {});
      for (const k of Object.keys(proj.mcpServers ?? {})) mcp.add(k);
    }
    const settings = readJson<{ enabledPlugins?: Record<string, boolean> }>(path.join(home, 'settings.json'), {});
    for (const [k, v] of Object.entries(settings.enabledPlugins ?? {})) if (v) plugins.add(k.split('@')[0]!);
    const skillDirs = [path.join(home, 'skills'), cwd ? path.join(cwd, '.claude', 'skills') : ''].filter(Boolean);
    for (const d of skillDirs) {
      if (!fs.existsSync(d)) continue;
      for (const s of fs.readdirSync(d)) if (fs.existsSync(path.join(d, s, 'SKILL.md'))) skills.add(s);
    }
  } catch {
    /* inventory is best-effort */
  }
  return { mcp: [...mcp], skills: [...skills], plugins: [...plugins] };
}

function updateActive(session: string, patch: Record<string, unknown>, remove = false): void {
  const file = activeFile();
  const active = readJson<Record<string, Record<string, unknown>>>(file, {});
  if (remove) delete active[session];
  else active[session] = { ...(active[session] ?? {}), ...patch, last_seen: nowIso() };
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const [k, v] of Object.entries(active)) if (Date.parse(String(v.last_seen ?? '')) < cutoff) delete active[k];
  writeJson(file, active);
}

function historyLessons(cwd: string | undefined): string {
  if (!cwd) return '';
  const key = repoKey(cwd);
  const file = historyFile();
  if (!fs.existsSync(file)) return '';
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').slice(-200);
  const lessons: string[] = [];
  for (const line of lines.reverse()) {
    try {
      const h = JSON.parse(line) as { repo?: string; recommendations?: string[]; final_status?: string; task_title?: string; verdict?: string };
      if (h.repo !== key) continue;
      for (const r of h.recommendations ?? []) if (lessons.length < 3 && !lessons.includes(r)) lessons.push(r);
      if (h.final_status === 'reverted' || h.final_status === 'needed rework') {
        const l = `Last time "${h.task_title ?? 'a task'}" was judged ${h.verdict ?? ''} but later ${h.final_status}. Verify against the acceptance criteria before shipping.`;
        if (lessons.length < 3 && !lessons.includes(l)) lessons.push(l);
      }
      if (lessons.length >= 3) break;
    } catch {
      /* skip */
    }
  }
  return lessons.length ? `[Tally] Lessons from past receipts in this repo:\n- ${lessons.join('\n- ')}` : '';
}

function deliverInjects(session: string): string {
  const file = path.join(sessionDir(session), 'inject.jsonl');
  if (!fs.existsSync(file)) return '';
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  const pending: string[] = [];
  const kept: string[] = [];
  for (const line of lines) {
    try {
      const item = JSON.parse(line) as { note: string; delivered?: boolean };
      if (item.delivered) kept.push(line);
      else {
        pending.push(item.note);
        kept.push(JSON.stringify({ ...item, delivered: true, delivered_at: nowIso() }));
      }
    } catch {
      /* skip */
    }
  }
  if (!pending.length) return '';
  fs.writeFileSync(file, kept.join('\n') + '\n');
  return pending.map((n) => `[Tally] ${n}`).join('\n');
}

function followupDue(): boolean {
  const state = readJson<{ last_run?: string }>(path.join(tallyHome(), 'followup-state.json'), {});
  const last = state.last_run ? Date.parse(state.last_run) : 0;
  return Date.now() - last > 24 * 3600 * 1000;
}

function main(): void {
  const raw = readStdin();
  let input: HookInput = {};
  try {
    input = JSON.parse(raw) as HookInput;
  } catch {
    input = {};
  }
  if (!input || typeof input !== 'object') input = {};
  const event = process.argv[2] || input.hook_event_name || 'Unknown';
  const session = String(input.session_id || 'unknown');
  const cwd = input.cwd;
  ensureDir(sessionDir(session));
  let out: { hookSpecificOutput: { hookEventName: string; additionalContext: string } } | undefined;

  switch (event) {
    case 'SessionStart': {
      const loaded = loadedInventory(cwd);
      record(session, 'session_start', cwd, {
        source: input.source,
        model: input.model,
        transcript_path: input.transcript_path,
        git_head: gitHead(cwd),
        loaded,
      });
      updateActive(session, { cwd, transcript_path: input.transcript_path, model: input.model, started: nowIso() });
      const ctx = [historyLessons(cwd), deliverInjects(session)].filter(Boolean).join('\n');
      if (ctx) out = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } };
      if (followupDue()) spawnDetached(['followup', '--auto']);
      break;
    }
    case 'UserPromptSubmit': {
      const prompt = String(input.prompt ?? '');
      const isFirst = !fs.existsSync(path.join(sessionDir(session), 'task.json')) && !fs.existsSync(path.join(sessionDir(session), 'task.pending'));
      record(session, 'prompt', cwd, { prompt: truncate(prompt), chars: prompt.length });
      updateActive(session, { cwd, transcript_path: input.transcript_path });
      if (isFirst) {
        const url = TASK_URL_RE.exec(prompt)?.[0];
        const md = !url ? TASK_MD_RE.exec(prompt)?.[1] : undefined;
        const ref = url ?? (md && cwd && fs.existsSync(path.resolve(cwd, md)) ? path.resolve(cwd, md) : undefined);
        if (ref) {
          fs.writeFileSync(path.join(sessionDir(session), 'task.pending'), ref);
          spawnDetached(['task', ref, '--session', session, '--cwd', cwd ?? '', '--auto']);
        } else if (prompt.trim().length > 0) {
          fs.writeFileSync(path.join(sessionDir(session), 'task.pending'), 'text');
          spawnDetached(['task', '--text', truncate(prompt, 4000), '--session', session, '--cwd', cwd ?? '', '--auto']);
        }
      }
      const ctx = deliverInjects(session);
      if (ctx) out = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx } };
      break;
    }
    case 'PreToolUse': {
      record(session, 'pre_tool', cwd, {
        tool_name: input.tool_name,
        tool_input: shrinkInput(input.tool_input),
        tool_use_id: input.tool_use_id,
        agent: input.agent_id ?? null,
      });
      break;
    }
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const resp = input.tool_response;
      const respText = typeof resp === 'string' ? resp : JSON.stringify(resp ?? '');
      const isError =
        event === 'PostToolUseFailure' ||
        (!!resp && typeof resp === 'object' && ((resp as { is_error?: boolean }).is_error === true || (resp as { interrupted?: boolean }).interrupted === true)) ||
        /^\s*(Error|error:|Command failed|Exit code [1-9])/.test(respText);
      record(session, 'post_tool', cwd, {
        tool_name: input.tool_name,
        tool_input: shrinkInput(input.tool_input),
        tool_use_id: input.tool_use_id,
        is_error: isError,
        response_chars: respText.length,
        response_head: truncate(respText, 600),
        agent: input.agent_id ?? null,
      });
      const cmd = typeof input.tool_input?.command === 'string' ? input.tool_input.command : '';
      if (input.tool_name === 'Bash' && cmd && SHIP_RE.test(cmd) && !isError) {
        const kind = /gh\s+pr\s+create/.test(cmd) ? 'pr' : /gh\s+pr\s+merge/.test(cmd) ? 'merge' : /publish|upload/.test(cmd) ? 'publish' : 'push';
        const url = /https?:\/\/\S+/.exec(respText)?.[0];
        record(session, 'ship', cwd, { kind, command: redact(cmd), url });
        spawnDetached(['judge', session, '--auto', '--reason', kind]);
      }
      break;
    }
    case 'Stop': {
      record(session, 'stop', cwd, { last_assistant_message: truncate(input.last_assistant_message, 800) });
      updateActive(session, { cwd, transcript_path: input.transcript_path });
      break;
    }
    case 'PreCompact': {
      record(session, 'pre_compact', cwd, { trigger: input.trigger });
      break;
    }
    case 'Notification': {
      record(session, 'permission', cwd, { notification_type: input.notification_type, message: truncate(input.message, 400) });
      break;
    }
    case 'SessionEnd': {
      record(session, 'session_end', cwd, { reason: input.reason, transcript_path: input.transcript_path });
      updateActive(session, {}, true);
      spawnDetached(['finalize', session, '--auto']);
      break;
    }
    default: {
      record(session, 'note', cwd, { event, keys: Object.keys(input) });
    }
  }
  if (out) process.stdout.write(JSON.stringify(out));
}

function shrinkInput(input: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    if (k === 'content' || k === 'new_string' || k === 'old_string') out[k] = truncate(v, 300);
    else out[k] = typeof v === 'string' ? truncate(v, 600) : v;
  }
  return out;
}

try {
  main();
} catch {
  /* swallow: a hook must never fail the session */
}
process.exitCode = 0;
