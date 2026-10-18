/* Puts a dollar number on a story before the agent starts: the cost of the most similar past sessions on this machine.
   Every session Claude Code (or Codex) already left in ~/.claude/projects is a priced example; a session Tally linked
   to a ticket is described by the ticket's title and body, any other by its first prompts. Similarity is TF-IDF
   cosine over those words with a small same-repo bonus. The estimate is the similarity-weighted median of the
   neighbours' cost, the range their 25th–75th percentile. With fewer than two neighbours it falls back to the repo's
   median session, then to every session's median, and says so. Nothing leaves the machine and no model is called. */
import fs from 'node:fs';
import path from 'node:path';
import { readJson, repoKey, sessionDir } from '../paths.js';
import { scanSessions, type SessionCandidate } from '../backfill/scan.js';

export interface Neighbour {
  session: string;
  text: string;
  repo?: string;
  cost_usd: number;
  similarity: number;
  models: string[];
  started?: string;
}

export interface CostEstimate {
  usd: number;
  low_usd: number;
  high_usd: number;
  basis: 'similar' | 'repo' | 'all' | 'none';
  confidence: 'high' | 'medium' | 'low';
  n: number;
  corpus: number;
  neighbours: Neighbour[];
  computed_at: string;
}

export interface CorpusDoc {
  session: string;
  text: string;
  repo?: string;
  cost_usd: number;
  models: string[];
  started?: string;
}

const STOP = new Set(
  'the and for with that this from into have has are was were will would should could can not but you your our their them they its use using please make need needs want also then than when what which there here just like some any all each other more most very about after before over under only into onto off out via per a an to of in on at by is it be as or if so do we i me my'.split(' '),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/<\/?pasted_content[^>]*>/g, ' ')
    .replace(/https?:\/\/\S+/g, (u) => u.replace(/[/.:#?=&_-]+/g, ' '))
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w) && w.length < 30);
}

/* a session is a story only if the agent did something; pure chats and Tally's own runs are not examples */
function isStory(c: SessionCandidate): boolean {
  return c.tool_calls > 0 && c.cost > 0.005;
}

/* "plan.md is the task": the story is in the file, not the prompt; read it while it is still in the repo */
export function storyText(prompts: string[], cwd?: string): string {
  const head = prompts.slice(0, 2).join('\n');
  const refs = cwd ? [...head.matchAll(/(?:^|\s)([\w./-]+\.md)\b/g)].map((m) => m[1]!).slice(0, 2) : [];
  const files = refs
    .map((r) => path.resolve(cwd!, r))
    .filter((f) => f.startsWith(path.resolve(cwd!)) && fs.existsSync(f) && fs.statSync(f).isFile())
    .map((f) => fs.readFileSync(f, 'utf8').slice(0, 3000));
  return [head, ...files].join('\n').slice(0, 6000);
}

function docText(c: SessionCandidate): string {
  const task = readJson<{ title?: string; body_excerpt?: string } | null>(path.join(sessionDir(c.session), 'task.json'), null);
  if (task?.title) return `${task.title}\n${task.body_excerpt ?? ''}`.slice(0, 3000);
  return storyText(c.prompts, c.cwd);
}

export function buildCorpus(opts: { since?: string; projectsDir?: string } = {}): CorpusDoc[] {
  return scanSessions({ since: opts.since ?? '365d', projectsDir: opts.projectsDir })
    .filter(isStory)
    .map((c) => ({ session: c.session, text: docText(c), repo: c.repo, cost_usd: c.cost, models: c.models.filter((m) => !m.startsWith('<')), started: c.started }));
}

type Vec = Map<string, number>;

function tf(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

function vectorize(counts: Map<string, number>, idf: Map<string, number>, fallbackIdf: number): Vec {
  const v: Vec = new Map();
  let norm = 0;
  for (const [t, n] of counts) {
    const w = (1 + Math.log(n)) * (idf.get(t) ?? fallbackIdf);
    v.set(t, w);
    norm += w * w;
  }
  norm = Math.sqrt(norm) || 1;
  for (const [t, w] of v) v.set(t, w / norm);
  return v;
}

function cosine(a: Vec, b: Vec): number {
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  let s = 0;
  for (const [t, w] of small) s += w * (large.get(t) ?? 0);
  return s;
}

export function quantile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

function weightedMedian(items: Array<{ v: number; w: number }>): number {
  const s = [...items].sort((a, b) => a.v - b.v);
  const total = s.reduce((acc, x) => acc + x.w, 0);
  let acc = 0;
  for (const x of s) {
    acc += x.w;
    if (acc >= total / 2) return x.v;
  }
  return s[s.length - 1]?.v ?? 0;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export const MIN_SIMILARITY = 0.2;
export const MAX_NEIGHBOURS = 7;
export const STRONG_SIMILARITY = 0.3;

export function estimateFromCorpus(text: string, corpus: CorpusDoc[], opts: { cwd?: string; exclude?: string; excludeText?: boolean; now?: Date } = {}): CostEstimate {
  const same = (d: CorpusDoc) => opts.excludeText && d.text.trim().toLowerCase() === text.trim().toLowerCase();
  const docs = corpus.filter((d) => d.session !== opts.exclude && !same(d));
  const repo = opts.cwd ? repoKey(opts.cwd) : undefined;
  const computed_at = (opts.now ?? new Date()).toISOString();
  const tokenized = docs.map((d) => tf(tokenize(d.text)));
  const df = new Map<string, number>();
  for (const counts of tokenized) for (const t of counts.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const N = docs.length;
  const idf = new Map<string, number>();
  for (const [t, n] of df) idf.set(t, Math.log((N + 1) / (n + 1)) + 1);
  const fallbackIdf = Math.log(N + 1) + 1;
  const q = vectorize(tf(tokenize(text)), idf, fallbackIdf);
  const scored = docs
    .map((d, i) => {
      const sim = q.size ? cosine(q, vectorize(tokenized[i]!, idf, fallbackIdf)) : 0;
      return { d, sim: sim > 0 && repo && d.repo === repo ? Math.min(1, sim + 0.1) : sim };
    })
    .filter((x) => x.sim >= MIN_SIMILARITY)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, MAX_NEIGHBOURS);
  const neighbours: Neighbour[] = scored.map(({ d, sim }) => ({ session: d.session, text: d.text.split('\n')[0]!.slice(0, 100), repo: d.repo, cost_usd: round2(d.cost_usd), similarity: round2(sim), models: d.models, started: d.started }));
  /* two neighbours, or one close one, are enough to say "a story like this cost about X"; one alone is low confidence
     and its range is half to double its cost */
  if (scored.length >= 2 || (scored.length === 1 && scored[0]!.sim >= STRONG_SIMILARITY)) {
    const costs = scored.map((x) => x.d.cost_usd);
    const usd = weightedMedian(scored.map((x) => ({ v: x.d.cost_usd, w: x.sim })));
    const confidence = scored.length >= 5 && scored[0]!.sim >= 0.4 ? 'high' : scored.length >= 3 ? 'medium' : 'low';
    const [low, high] = scored.length === 1 ? [usd / 2, usd * 2] : [quantile(costs, 0.25), quantile(costs, 0.75)];
    return { usd: round2(usd), low_usd: round2(low), high_usd: round2(high), basis: 'similar', confidence, n: scored.length, corpus: N, neighbours, computed_at };
  }
  const repoDocs = repo ? docs.filter((d) => d.repo === repo) : [];
  const pool = repoDocs.length >= 3 ? repoDocs : docs;
  if (!pool.length) return { usd: 0, low_usd: 0, high_usd: 0, basis: 'none', confidence: 'low', n: 0, corpus: N, neighbours, computed_at };
  const costs = pool.map((d) => d.cost_usd);
  return { usd: round2(quantile(costs, 0.5)), low_usd: round2(quantile(costs, 0.25)), high_usd: round2(quantile(costs, 0.75)), basis: pool === repoDocs ? 'repo' : 'all', confidence: 'low', n: pool.length, corpus: N, neighbours, computed_at };
}

export function estimateCost(text: string, opts: { cwd?: string; exclude?: string; since?: string; projectsDir?: string } = {}): CostEstimate {
  return estimateFromCorpus(text, buildCorpus({ since: opts.since, projectsDir: opts.projectsDir }), opts);
}

export interface Backtest {
  sessions: number;
  by_basis: Record<string, number>;
  median_abs_pct_error: number;
  within_2x_pct: number;
  inside_range_pct: number;
  /* the same, for the sessions that had similar neighbours */
  similar: { sessions: number; median_abs_pct_error: number; within_2x_pct: number };
}

/* leave-one-out: estimate every past story from all the others and compare with what it actually cost. Sessions
   with word-for-word the same opening (a scripted harness, a re-run) are left out of each other's estimates, since
   they would flatter the number. */
export function backtest(corpus: CorpusDoc[]): Backtest {
  const rows = corpus.map((d) => {
    const e = estimateFromCorpus(d.text, corpus, { exclude: d.session, excludeText: true });
    const ape = d.cost_usd > 0 ? Math.abs(e.usd - d.cost_usd) / d.cost_usd : 0;
    const ratio = e.usd > 0 && d.cost_usd > 0 ? Math.max(e.usd / d.cost_usd, d.cost_usd / e.usd) : Infinity;
    return { basis: e.basis, ape, within2: ratio <= 2, inside: d.cost_usd >= e.low_usd && d.cost_usd <= e.high_usd };
  });
  const pct = (xs: boolean[]) => (xs.length ? Math.round((xs.filter(Boolean).length / xs.length) * 100) : 0);
  const sim = rows.filter((r) => r.basis === 'similar');
  const by_basis: Record<string, number> = {};
  for (const r of rows) by_basis[r.basis] = (by_basis[r.basis] ?? 0) + 1;
  return {
    sessions: rows.length,
    by_basis,
    median_abs_pct_error: Math.round(quantile(rows.map((r) => r.ape), 0.5) * 100),
    within_2x_pct: pct(rows.map((r) => r.within2)),
    inside_range_pct: pct(rows.map((r) => r.inside)),
    similar: { sessions: sim.length, median_abs_pct_error: Math.round(quantile(sim.map((r) => r.ape), 0.5) * 100), within_2x_pct: pct(sim.map((r) => r.within2)) },
  };
}

export function estimateFile(session: string): string {
  return path.join(sessionDir(session), 'estimate.json');
}

export function loadEstimate(session: string): CostEstimate | null {
  const f = estimateFile(session);
  return fs.existsSync(f) ? readJson<CostEstimate | null>(f, null) : null;
}

export function fmtEstimate(e: CostEstimate): string {
  const $ = (n: number) => `$${n.toFixed(2)}`;
  if (e.basis === 'none') return 'no past sessions on this machine to estimate from yet';
  const what = e.basis === 'similar' ? `${e.n} similar past ${e.n === 1 ? 'story' : 'stories'}` : e.basis === 'repo' ? `the median of ${e.n} past sessions in this repo (nothing similar enough)` : `the median of all ${e.n} past sessions (nothing similar enough)`;
  return `~${$(e.usd)} (typical ${$(e.low_usd)}–${$(e.high_usd)}; from ${what}; ${e.confidence} confidence)`;
}
