import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig, type Config } from '../config.js';
import { makeLlm, recordTallySpend, type LlmClient, type LlmRequest, type LlmResult } from '../llm/client.js';
import { judgeSession } from '../judge/judge.js';
import { TaskSchema, type Task } from '../task/intake.js';
import { readEventsFile } from '../store/events.js';
import { packageRoot, sessionDir, ensureDir } from '../paths.js';
import { buildCalibrationReport, entryFromJudge, type CalibrationEntry, type CalibrationReport, type Status, type VerdictText } from './calibrate.js';
import type { Judge } from '../judge/schema.js';

export interface RecordedCall {
  tier: 1 | 2;
  model: string;
  cost_usd: number;
  prompt_tokens: number;
  data: unknown;
}

export interface FixtureCase {
  name: string;
  dir: string;
  task: Task;
  repo: { base: Record<string, string>; after: Record<string, string>; delete?: string[] };
  expected: { criteria: Record<string, Status>; verdict: VerdictText; notes?: string };
  recorded?: { calls: RecordedCall[] };
}

export function fixturesRoot(): string {
  return path.join(packageRoot(), 'test', 'fixtures', 'calibration');
}

export function baselineFile(): string {
  return path.join(fixturesRoot(), 'baseline.json');
}

export function loadFixtures(root = fixturesRoot()): FixtureCase[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((d) => fs.existsSync(path.join(root, d, 'expected.json')))
    .sort()
    .map((name) => {
      const dir = path.join(root, name);
      const read = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as unknown;
      const recordedPath = path.join(dir, 'model-output.json');
      let recorded: FixtureCase['recorded'];
      if (fs.existsSync(recordedPath)) {
        const raw = read('model-output.json') as { calls?: RecordedCall[] };
        recorded = Array.isArray(raw.calls) ? { calls: raw.calls } : undefined;
      }
      return { name, dir, task: TaskSchema.parse(read('task.json')), repo: read('repo.json') as FixtureCase['repo'], expected: read('expected.json') as FixtureCase['expected'], recorded };
    });
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

export function materializeRepo(c: FixtureCase, root: string): { cwd: string; base: string } {
  const cwd = path.join(root, c.name);
  fs.mkdirSync(cwd, { recursive: true });
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.email', 'fixture@tally.local');
  git(cwd, 'config', 'user.name', 'tally fixture');
  for (const [f, content] of Object.entries(c.repo.base)) {
    fs.mkdirSync(path.dirname(path.join(cwd, f)), { recursive: true });
    fs.writeFileSync(path.join(cwd, f), content);
  }
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', 'base');
  const base = git(cwd, 'rev-parse', 'HEAD');
  for (const [f, content] of Object.entries(c.repo.after)) {
    fs.mkdirSync(path.dirname(path.join(cwd, f)), { recursive: true });
    fs.writeFileSync(path.join(cwd, f), content);
  }
  for (const f of c.repo.delete ?? []) if (fs.existsSync(path.join(cwd, f))) fs.unlinkSync(path.join(cwd, f));
  return { cwd, base };
}

/* Replays recorded model calls tier by tier and books their real recorded cost, so self-share in CI is the live number. */
export class ReplayLlm implements LlmClient {
  used = 0;
  constructor(private readonly calls: RecordedCall[], private readonly session: string) {}
  async complete<T>(req: LlmRequest): Promise<LlmResult<T>> {
    if (req.kind !== 'judge') throw new Error(`ReplayLlm: unexpected ${req.kind} call`);
    const call = this.calls.find((c, i) => i >= this.used && c.tier === req.tier);
    if (!call) throw new Error(`ReplayLlm: no recorded tier ${req.tier} call (recorded: ${this.calls.map((c) => 'tier' + c.tier).join(', ') || 'none'}); re-record with --live --record`);
    this.used = this.calls.indexOf(call) + 1;
    const usage = { input: call.prompt_tokens, output: 300, cache_write: 0, cache_write_1h: 0, cache_read: 0 };
    recordTallySpend({ kind: `judge:tier${call.tier}`, model: call.model, cost_usd: call.cost_usd, usage, session: this.session });
    return { data: call.data as T, usage, cost_usd: call.cost_usd, model: call.model, duration_ms: 1 };
  }
}

export interface FixtureResult {
  name: string;
  session: string;
  judge: Judge;
  entry: CalibrationEntry;
  matches: number;
  total: number;
  verdict_match: boolean;
  calls: RecordedCall[];
}

export async function runFixture(c: FixtureCase, opts: { cfg?: Config; live?: boolean; llm?: LlmClient; workRoot?: string; deep?: boolean }): Promise<FixtureResult> {
  const cfg = opts.cfg ?? loadConfig();
  const workRoot = opts.workRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'tally-cal-'));
  const { cwd, base } = materializeRepo(c, workRoot);
  const session = c.task.session;
  ensureDir(sessionDir(session));
  const transcriptPath = path.join(sessionDir(session), 'transcript.jsonl');
  fs.copyFileSync(path.join(c.dir, 'transcript.jsonl'), transcriptPath);
  const events = readEventsFile(path.join(c.dir, 'events.jsonl')).map((e) => (e.type === 'session_start' ? { ...e, session, cwd, data: { ...e.data, git_head: base } } : { ...e, session, cwd }));
  const calls: RecordedCall[] = [];
  let llm: LlmClient;
  if (opts.llm) llm = opts.llm;
  else if (opts.live) {
    const real = makeLlm({ session });
    llm = {
      complete: async (req) => {
        const r = await real.complete<unknown>(req);
        if (req.kind === 'judge') calls.push({ tier: req.tier ?? 2, model: r.model, cost_usd: r.cost_usd, prompt_tokens: Math.ceil(req.prompt.length / 4), data: r.data });
        return r as never;
      },
    };
  } else {
    if (!c.recorded) throw new Error(`${c.name}: no model-output.json recorded; run \`tally calibrate eval --live --record\` once`);
    llm = new ReplayLlm(c.recorded.calls, session);
  }
  const task = { ...c.task, cwd };
  const judge = await judgeSession({ session, cwd, transcriptPath, cfg, llm, reason: 'push', events, task, consent: true, deep: opts.deep });
  const human = judge.criteria.map((cr) => c.expected.criteria[cr.id] ?? 'unverifiable');
  const entry = entryFromJudge(judge, human, c.expected.verdict, 'fixture');
  const matches = entry.criteria.filter((x) => x.human === x.judge).length;
  return { name: c.name, session, judge, entry, matches, total: entry.criteria.length, verdict_match: judge.verdict.verdict === c.expected.verdict, calls };
}

export interface EvalSummary {
  fixtures: Array<{ name: string; matches: number; total: number; verdict_match: boolean; judge_verdict: string; expected_verdict: string; statuses: Array<{ id: string; human: Status; judge: Status; resolved_by: string }>; session_usd: number; tally_usd: number; share_pct: number; tiers: string[]; tier_reason: string }>;
  report: CalibrationReport;
  criterion_agreement: number;
  verdict_agreement: number;
  avg_share_pct: number;
  total_session_usd: number;
  total_tally_usd: number;
  live: boolean;
  judge_model: string;
  baseline_updated?: boolean;
}

export async function runEval(opts: { live?: boolean; record?: boolean; cfg?: Config; llmFor?: (c: FixtureCase) => LlmClient; only?: string[]; deep?: boolean }): Promise<EvalSummary> {
  const cases = loadFixtures().filter((c) => !opts.only?.length || opts.only.includes(c.name));
  if (!cases.length) throw new Error('no calibration fixtures found');
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-cal-'));
  const results: FixtureResult[] = [];
  for (const c of cases) {
    const r = await runFixture(c, { cfg: opts.cfg, live: opts.live, llm: opts.llmFor?.(c), workRoot, deep: opts.deep });
    results.push(r);
  }
  fs.rmSync(workRoot, { recursive: true, force: true });
  const report = buildCalibrationReport(results.map((r) => r.entry));
  const fixtures = results.map((r) => ({
    name: r.name,
    matches: r.matches,
    total: r.total,
    verdict_match: r.verdict_match,
    judge_verdict: r.judge.verdict.verdict,
    expected_verdict: r.entry.human_verdict ?? '',
    statuses: r.judge.criteria.map((c, i) => ({ id: c.id, human: r.entry.criteria[i]!.human, judge: c.status, resolved_by: c.resolved_by })),
    session_usd: r.judge.cost.total_usd,
    tally_usd: r.judge.cost.tally_own_usd,
    share_pct: r.judge.cost.tally_share_pct,
    tiers: r.judge.tiers.ran,
    tier_reason: r.judge.tiers.reason,
  }));
  const totalSession = fixtures.reduce((s, f) => s + f.session_usd, 0);
  const totalTally = fixtures.reduce((s, f) => s + f.tally_usd, 0);
  const summary: EvalSummary = {
    fixtures,
    report,
    criterion_agreement: report.criterion_agreement ?? 0,
    verdict_agreement: report.verdict_agreement ?? 0,
    avg_share_pct: fixtures.length ? fixtures.reduce((s, f) => s + f.share_pct, 0) / fixtures.length : 0,
    total_session_usd: totalSession,
    total_tally_usd: totalTally,
    live: !!opts.live,
    judge_model: results.flatMap((r) => r.judge.tiers.calls.map((c) => c.model)).filter((m, i, a) => a.indexOf(m) === i).join('+') || 'mechanical',
  };
  if (opts.record) {
    /* the baseline is a floor: it is only rewritten when agreement holds or improves, never lowered by a worse run */
    const old = loadBaseline();
    /* a subset run (--only) records its fixtures' model output but never rewrites the shared baseline, which describes the full set */
    if (!old || summary.criterion_agreement >= old.criterion_agreement - 1e-9) {
      /* model outputs and baseline are written together so a replay always reproduces the recorded agreement */
      for (const r of results) fs.writeFileSync(path.join(cases.find((c) => c.name === r.name)!.dir, 'model-output.json'), JSON.stringify({ recorded_at: new Date().toISOString(), calls: r.calls }, null, 2) + '\n');
      if (!opts.only?.length) fs.writeFileSync(baselineFile(), JSON.stringify({ recorded_at: new Date().toISOString(), judge_model: summary.judge_model, criterion_agreement: summary.criterion_agreement, verdict_agreement: summary.verdict_agreement, avg_share_pct: Math.round(summary.avg_share_pct * 100) / 100, fixtures: fixtures.map((f) => ({ name: f.name, matches: f.matches, total: f.total, verdict_match: f.verdict_match, session_usd: f.session_usd, tally_usd: f.tally_usd, share_pct: f.share_pct, tiers: f.tiers })) }, null, 2) + '\n');
      summary.baseline_updated = true;
    } else summary.baseline_updated = false;
  }
  return summary;
}

export function loadBaseline(): { recorded_at?: string; judge_model?: string; criterion_agreement: number; verdict_agreement: number; avg_share_pct?: number } | null {
  const f = baselineFile();
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8')) as { recorded_at?: string; judge_model?: string; criterion_agreement: number; verdict_agreement: number; avg_share_pct?: number };
}

export function renderOverheadTable(s: EvalSummary): string {
  const L: string[] = [];
  L.push('fixture                    session $   tally $   share   tiers');
  for (const f of s.fixtures) L.push(`${f.name.padEnd(26)} ${('$' + f.session_usd.toFixed(3)).padStart(9)} ${('$' + f.tally_usd.toFixed(3)).padStart(9)} ${(f.share_pct.toFixed(1) + '%').padStart(7)}   ${f.tiers.map((t) => t.replace('tier', '')).join('→')}  ${f.tier_reason}`);
  L.push(`${'average / total'.padEnd(26)} ${('$' + s.total_session_usd.toFixed(3)).padStart(9)} ${('$' + s.total_tally_usd.toFixed(3)).padStart(9)} ${(s.avg_share_pct.toFixed(1) + '%').padStart(7)}`);
  return L.join('\n');
}
