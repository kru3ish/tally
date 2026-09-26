/* Quick mechanical checks against the working tree, cheap enough for a hook and an MCP call: no model, no zod, no
   transcript. Reads task.json raw, resolves file_exists / file_contains / file_changed / diff_contains with fs and one
   `git diff` from the session's base commit, and writes progress.json for the status line. tests_pass, command and pr
   are reported as "needs the Judge" here; only `tally judge` runs tests. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sessionDir, readJson, writeJson } from '../paths.js';

export interface QuickItem {
  id: string;
  text: string;
  kind: string;
  status: 'met' | 'unmet' | 'unknown';
  why: string;
}

export interface Progress {
  ts: string;
  met: number;
  checked: number;
  total: number;
  items: QuickItem[];
}

interface RawTask {
  criteria?: Array<{ id: string; text: string; kind?: string; check?: { kind: string; path?: string; pattern?: string; command?: string; state?: string } }>;
}

function safeRegex(p: string): RegExp | null {
  try {
    return new RegExp(p, 'i');
  } catch {
    return null;
  }
}

function baseHead(session: string): string | undefined {
  const f = path.join(sessionDir(session), 'events.jsonl');
  if (!fs.existsSync(f)) return undefined;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.includes('"session_start"')) continue;
    try {
      const e = JSON.parse(line) as { type?: string; data?: { git_head?: string } };
      if (e.type === 'session_start' && e.data?.git_head) return e.data.git_head;
    } catch {
      /* skip */
    }
  }
  return undefined;
}

function gitDiff(cwd: string, base: string | undefined): { files: string[]; text: string } {
  if (!fs.existsSync(path.join(cwd, '.git'))) return { files: [], text: '' };
  const range = base ? [base] : ['HEAD'];
  const names = spawnSync('git', ['diff', '--name-only', ...range], { cwd, encoding: 'utf8', windowsHide: true, timeout: 3000 });
  const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd, encoding: 'utf8', windowsHide: true, timeout: 3000 });
  const files = [...(names.stdout ?? '').split('\n'), ...(untracked.stdout ?? '').split('\n')].map((s) => s.trim()).filter(Boolean);
  const diff = spawnSync('git', ['diff', '--no-color', ...range], { cwd, encoding: 'utf8', windowsHide: true, timeout: 3000, maxBuffer: 8 * 1024 * 1024 });
  return { files, text: diff.stdout ?? '' };
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();

export function quickChecks(session: string, cwd: string | undefined): Progress {
  const task = readJson<RawTask | null>(path.join(sessionDir(session), 'task.json'), null);
  const criteria = task?.criteria ?? [];
  const items: QuickItem[] = [];
  let diff: { files: string[]; text: string } | null = null;
  const getDiff = () => (diff ??= cwd ? gitDiff(cwd, baseHead(session)) : { files: [], text: '' });
  for (const c of criteria) {
    const ch = c.check;
    if (!ch || ch.kind === 'none') {
      items.push({ id: c.id, text: c.text, kind: 'judgment', status: 'unknown', why: 'needs the Judge (a reader decides this one)' });
      continue;
    }
    if (ch.kind === 'file_exists' && ch.path && cwd) {
      const ok = fs.existsSync(path.join(cwd, ch.path));
      items.push({ id: c.id, text: c.text, kind: ch.kind, status: ok ? 'met' : 'unmet', why: `${ch.path} ${ok ? 'exists' : 'does not exist'}` });
    } else if (ch.kind === 'file_contains' && ch.path && ch.pattern && cwd) {
      const p = path.join(cwd, ch.path);
      const re = safeRegex(ch.pattern);
      /* a path whose directory does not exist in the repo was guessed by the intake model (test/ vs tests/); that is
         "needs the Judge", not a failed criterion the Stop gate should hold the agent on */
      if (!fs.existsSync(p)) items.push({ id: c.id, text: c.text, kind: ch.kind, status: fs.existsSync(path.dirname(p)) ? 'unmet' : 'unknown', why: `${ch.path} does not exist${fs.existsSync(path.dirname(p)) ? '' : ' (nor its directory; the path may be a guess)'}` });
      else if (!re) items.push({ id: c.id, text: c.text, kind: ch.kind, status: 'unknown', why: 'invalid pattern' });
      else {
        const ok = re.test(fs.readFileSync(p, 'utf8'));
        items.push({ id: c.id, text: c.text, kind: ch.kind, status: ok ? 'met' : 'unmet', why: `${ch.path} ${ok ? 'matches' : 'does not match'} /${ch.pattern}/` });
      }
    } else if (ch.kind === 'file_changed' && ch.path) {
      const d = getDiff();
      const want = norm(ch.path);
      const hit = ch.path === '.' || ch.path === '*' ? d.files[0] : d.files.find((f) => norm(f) === want || norm(f).endsWith('/' + want) || want.endsWith('/' + norm(f)));
      items.push({ id: c.id, text: c.text, kind: ch.kind, status: hit ? 'met' : 'unmet', why: hit ? `${hit} is changed` : `${ch.path} is not changed yet (${d.files.length} file(s) changed so far)` });
    } else if (ch.kind === 'diff_contains' && ch.pattern) {
      const d = getDiff();
      const re = safeRegex(ch.pattern);
      const ok = !!re && re.test(d.text);
      items.push({ id: c.id, text: c.text, kind: ch.kind, status: ok ? 'met' : 'unmet', why: ok ? `the diff matches /${ch.pattern}/` : `the diff does not match /${ch.pattern}/ yet` });
    } else {
      items.push({ id: c.id, text: c.text, kind: ch.kind, status: 'unknown', why: ch.kind === 'tests_pass' ? 'tests are run by the Judge (tally judge), not here' : ch.kind === 'pr' ? 'decided by the push / PR events at judge time' : `${ch.kind} is run by the Judge` });
    }
  }
  const checked = items.filter((i) => i.status !== 'unknown').length;
  const progress: Progress = { ts: new Date().toISOString(), met: items.filter((i) => i.status === 'met').length, checked, total: items.length, items };
  try {
    writeJson(path.join(sessionDir(session), 'progress.json'), progress);
  } catch {
    /* never fail the caller */
  }
  return progress;
}

export function readProgress(session: string): Progress | null {
  return readJson<Progress | null>(path.join(sessionDir(session), 'progress.json'), null);
}
