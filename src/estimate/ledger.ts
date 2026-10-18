/* The team ledger: one line per finished story in <repo>/.tally/ledger.jsonl. It travels with the repository, so
   committing it gives everyone who clones the repo the team's history for estimates and the dashboard. A line holds
   numbers, the story's key and title, the model, the drivers and fixes by id, and the author's git name (already in
   the repo's own history). Never prompts, code, diffs or file paths. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { CostCheck } from './variance.js';

export interface LedgerEntry {
  v: 1;
  ts: string;
  session: string;
  story: string;
  key?: string;
  url?: string;
  story_points?: number;
  author?: string;
  agent: string;
  model: string;
  estimate_usd?: number;
  estimate_low_usd?: number;
  estimate_high_usd?: number;
  estimate_basis?: string;
  estimate_n?: number;
  actual_usd: number;
  delta_usd?: number;
  status: CostCheck['status'];
  savable_usd: number;
  drivers: Array<{ id: string; usd: number; fix?: string; group?: 'waste' | 'add' }>;
  fixes_applied?: string[];
}

export function repoRoot(cwd: string): string | undefined {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

export function ledgerFile(root: string): string {
  return path.join(root, '.tally', 'ledger.jsonl');
}

export function readLedger(cwd: string): LedgerEntry[] {
  const root = repoRoot(cwd);
  if (!root) return [];
  const f = ledgerFile(root);
  if (!fs.existsSync(f)) return [];
  const bySession = new Map<string, LedgerEntry>();
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as LedgerEntry;
      /* a re-recorded session replaces its earlier line; merges from two branches keep both until then */
      if (e && e.v === 1 && typeof e.actual_usd === 'number' && e.session) bySession.set(e.session, e);
    } catch {
      /* a merge conflict marker or a truncated line is skipped, never fatal */
    }
  }
  return [...bySession.values()].sort((a, b) => a.ts.localeCompare(b.ts));
}

function gitUser(root: string): string | undefined {
  const r = spawnSync('git', ['config', 'user.name'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 5000 });
  return r.status === 0 ? r.stdout.trim() || undefined : undefined;
}

export function entryFromCheck(c: CostCheck, extra: { agent?: string; key?: string; url?: string; story_points?: number; author?: string; fixes_applied?: string[]; now?: Date } = {}): LedgerEntry {
  const e = c.estimate;
  return {
    v: 1,
    ts: (extra.now ?? new Date()).toISOString(),
    session: c.session,
    story: (c.task ?? 'untitled').split('\n')[0]!.slice(0, 140),
    ...(extra.key ? { key: extra.key } : {}),
    ...(extra.url ? { url: extra.url } : {}),
    ...(extra.story_points ? { story_points: extra.story_points } : {}),
    ...(extra.author ? { author: extra.author } : {}),
    agent: extra.agent ?? 'claude-code',
    model: c.model,
    ...(e && e.basis !== 'none' ? { estimate_usd: e.usd, estimate_low_usd: e.low_usd, estimate_high_usd: e.high_usd, estimate_basis: e.basis, estimate_n: e.n } : {}),
    actual_usd: c.actual_usd,
    ...(c.delta_usd !== undefined ? { delta_usd: c.delta_usd } : {}),
    status: c.status,
    savable_usd: c.savable_usd,
    drivers: c.drivers.map((d) => ({ id: d.id, usd: d.usd, ...(d.fix ? { fix: d.fix.id } : {}), ...(d.group === 'add' ? { group: 'add' as const } : {}) })),
    ...(extra.fixes_applied?.length ? { fixes_applied: extra.fixes_applied } : {}),
  };
}

/* appends the story; a session already in the ledger is replaced by rewriting the file without its old line */
export function recordStory(cwd: string, entry: LedgerEntry): string | undefined {
  const root = repoRoot(cwd);
  if (!root) return undefined;
  const f = ledgerFile(root);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const author = entry.author ?? gitUser(root);
  const line = JSON.stringify(author ? { ...entry, author } : entry);
  if (fs.existsSync(f)) {
    const kept = fs
      .readFileSync(f, 'utf8')
      .split('\n')
      .filter((l) => l.trim() && !l.includes(`"session":${JSON.stringify(entry.session)}`));
    fs.writeFileSync(f, [...kept, line].join('\n') + '\n');
  } else fs.writeFileSync(f, line + '\n');
  return f;
}
