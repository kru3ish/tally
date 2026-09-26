/* Enumerates past Claude Code sessions from ~/.claude/projects and summarises each cheaply enough to list. */
import fs from 'node:fs';
import { agent } from '../agents/index.js';
import path from 'node:path';
import { claudeHome, isInternalCwd, tallyHome, readJson, writeJson, repoKey } from '../paths.js';
import { parseTranscriptFile } from '../transcript/parse.js';

export interface SessionCandidate {
  session: string;
  transcript: string;
  cwd?: string;
  repo?: string;
  branch?: string;
  started?: string;
  ended?: string;
  cost: number;
  prompts: string[];
  first_prompt: string;
  tool_calls: number;
  files_edited: string[];
  models: string[];
  version?: string;
  mtime: number;
}

interface IndexFile {
  entries: Record<string, SessionCandidate & { indexed_mtime: number }>;
}

export function indexFile(): string {
  return path.join(tallyHome(), 'backfill', 'index.json');
}

export function parseSince(s: string | undefined, now = Date.now()): number {
  if (!s) return now - 60 * 86400000;
  const m = /^(\d+)([dhwm])$/.exec(s.trim());
  if (m) {
    const n = Number(m[1]);
    const unit = m[2] === 'h' ? 3600000 : m[2] === 'd' ? 86400000 : m[2] === 'w' ? 7 * 86400000 : 30 * 86400000;
    return now - n * unit;
  }
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return t;
  throw new Error(`bad --since "${s}" (use 60d, 2w, 12h, or a date)`);
}

export function summarize(transcript: string): SessionCandidate | null {
  const t = parseTranscriptFile(transcript);
  if (t.internal || !t.prompts.length) return null;
  const edited = new Set<string>();
  for (const c of t.toolCalls) if (['Edit', 'Write', 'MultiEdit'].includes(c.name) && typeof c.input.file_path === 'string') edited.add(String(c.input.file_path).replace(/\\/g, '/'));
  return {
    session: t.sessionId || path.basename(transcript, '.jsonl'),
    transcript,
    cwd: t.cwd,
    repo: t.cwd ? repoKey(t.cwd) : undefined,
    branch: t.gitBranch,
    started: t.startedAt,
    ended: t.endedAt,
    cost: Math.round(t.cost * 10000) / 10000,
    prompts: t.prompts.map((p) => p.text.slice(0, 500)),
    first_prompt: t.prompts[0]?.text.slice(0, 200) ?? '',
    tool_calls: t.toolCalls.length,
    files_edited: [...edited].slice(0, 50),
    models: t.models,
    version: t.version,
    mtime: fs.statSync(transcript).mtimeMs,
  };
}

export function listTranscripts(projectsDir = path.join(claudeHome(), 'projects'), extraRoots: string[] = defaultExtraRoots()): string[] {
  const out: string[] = [];
  if (fs.existsSync(projectsDir)) {
    for (const d of fs.readdirSync(projectsDir)) {
      const dir = path.join(projectsDir, d);
      if (isInternalCwd(d) || !fs.statSync(dir).isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) if (f.endsWith('.jsonl')) out.push(path.join(dir, f));
    }
  }
  /* other agents' transcript roots (Codex rollouts live in dated subfolders) */
  for (const root of extraRoots) {
    if (!fs.existsSync(root)) continue;
    const walk = (dir: string, depth: number): void => {
      if (depth > 4) return;
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        try {
          if (fs.statSync(p).isDirectory()) walk(p, depth + 1);
          else if (/^rollout-.*\.jsonl$/.test(f)) out.push(p);
        } catch {
          /* unreadable entry */
        }
      }
    };
    walk(root, 0);
  }
  return out;
}

function defaultExtraRoots(): string[] {
  /* only when the default Claude projects dir is in use; tests relocate CLAUDE_CONFIG_DIR and expect isolation */
  return process.env.CLAUDE_CONFIG_DIR ? [] : agent('codex').transcriptRoots?.() ?? [];
}

export function scanSessions(opts: { since?: string; repo?: string; projectsDir?: string; now?: number; useIndex?: boolean } = {}): SessionCandidate[] {
  const since = parseSince(opts.since, opts.now);
  const wantRepo = opts.repo ? repoKey(opts.repo) : undefined;
  const idx = opts.useIndex === false ? { entries: {} } : readJson<IndexFile>(indexFile(), { entries: {} });
  const out: SessionCandidate[] = [];
  let dirty = false;
  for (const file of listTranscripts(opts.projectsDir)) {
    const st = fs.statSync(file);
    if (st.mtimeMs < since - 7 * 86400000) continue;
    const key = file.replace(/\\/g, '/');
    let c = idx.entries[key];
    if (!c || c.indexed_mtime !== st.mtimeMs) {
      try {
        const s = summarize(file);
        if (!s) {
          delete idx.entries[key];
          continue;
        }
        c = { ...s, indexed_mtime: st.mtimeMs };
        idx.entries[key] = c;
        dirty = true;
      } catch {
        continue;
      }
    }
    if (!c.started || Date.parse(c.started) < since) continue;
    if (wantRepo && c.repo !== wantRepo) continue;
    out.push(c);
  }
  if (dirty && opts.useIndex !== false) writeJson(indexFile(), idx);
  return out.sort((a, b) => (b.started ?? '').localeCompare(a.started ?? ''));
}
