import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig, type Config } from '../config.js';
import { makeLlm, StubLlm, type LlmClient } from '../llm/client.js';
import { judgeSession } from '../judge/judge.js';
import { TaskSchema, type Task } from '../task/intake.js';
import { readEventsFile } from '../store/events.js';
import { packageRoot, sessionDir, ensureDir } from '../paths.js';
import { buildCalibrationReport, entryFromJudge, type CalibrationEntry, type CalibrationReport, type Status, type VerdictText } from './calibrate.js';
import type { Judge } from '../judge/schema.js';

export interface FixtureCase {
  name: string;
  dir: string;
  task: Task;
  repo: { base: Record<string, string>; after: Record<string, string>; delete?: string[] };
  expected: { criteria: Record<string, Status>; verdict: VerdictText; notes?: string };
  recorded?: unknown;
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
      return {
        name,
        dir,
        task: TaskSchema.parse(read('task.json')),
        repo: read('repo.json') as FixtureCase['repo'],
        expected: read('expected.json') as FixtureCase['expected'],
        recorded: fs.existsSync(recordedPath) ? read('model-output.json') : undefined,
      };
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

export interface FixtureResult {
  name: string;
  session: string;
  judge: Judge;
  entry: CalibrationEntry;
  matches: number;
  total: number;
  verdict_match: boolean;
  model_output?: unknown;
}

export async function runFixture(c: FixtureCase, opts: { cfg?: Config; live?: boolean; llm?: LlmClient; workRoot?: string }): Promise<FixtureResult> {
  const cfg = opts.cfg ?? loadConfig();
  const workRoot = opts.workRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'tally-cal-'));
  const { cwd, base } = materializeRepo(c, workRoot);
  const session = c.task.session;
  ensureDir(sessionDir(session));
  const transcriptPath = path.join(sessionDir(session), 'transcript.jsonl');
  fs.copyFileSync(path.join(c.dir, 'transcript.jsonl'), transcriptPath);
  const events = readEventsFile(path.join(c.dir, 'events.jsonl')).map((e) => (e.type === 'session_start' ? { ...e, session, cwd, data: { ...e.data, git_head: base } } : { ...e, session, cwd }));
  let captured: unknown;
  let llm: LlmClient;
  if (opts.llm) llm = opts.llm;
  else if (opts.live) {
    const real = makeLlm({ session });
    llm = {
      complete: async (req) => {
        const r = await real.complete<unknown>(req);
        if (req.kind === 'judge') captured = r.data;
        return r as never;
      },
    };
  } else {
    if (!c.recorded) throw new Error(`${c.name}: no model-output.json recorded; run \`tally calibrate eval --live --record\` once`);
    llm = new StubLlm({ judge: () => c.recorded }, session);
  }
  const task = { ...c.task, cwd };
  const judge = await judgeSession({ session, cwd, transcriptPath, cfg, llm, reason: 'push', events, task, consent: true });
  const human = judge.criteria.map((cr) => c.expected.criteria[cr.id] ?? 'unverifiable');
  const entry = entryFromJudge(judge, human, c.expected.verdict, 'fixture');
  const matches = entry.criteria.filter((x) => x.human === x.judge).length;
  return { name: c.name, session, judge, entry, matches, total: entry.criteria.length, verdict_match: judge.verdict.verdict === c.expected.verdict, model_output: captured };
}

export interface EvalSummary {
  fixtures: Array<{ name: string; matches: number; total: number; verdict_match: boolean; judge_verdict: string; expected_verdict: string; statuses: Array<{ id: string; human: Status; judge: Status }> }>;
  report: CalibrationReport;
  criterion_agreement: number;
  verdict_agreement: number;
  live: boolean;
  judge_model: string;
}

export async function runEval(opts: { live?: boolean; record?: boolean; cfg?: Config; llmFor?: (c: FixtureCase) => LlmClient; only?: string[] }): Promise<EvalSummary> {
  const cases = loadFixtures().filter((c) => !opts.only?.length || opts.only.includes(c.name));
  if (!cases.length) throw new Error('no calibration fixtures found');
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-cal-'));
  const results: FixtureResult[] = [];
  for (const c of cases) {
    const r = await runFixture(c, { cfg: opts.cfg, live: opts.live, llm: opts.llmFor?.(c), workRoot });
    if (opts.record && r.model_output !== undefined) fs.writeFileSync(path.join(c.dir, 'model-output.json'), JSON.stringify(r.model_output, null, 2) + '\n');
    results.push(r);
  }
  fs.rmSync(workRoot, { recursive: true, force: true });
  const report = buildCalibrationReport(results.map((r) => r.entry));
  const summary: EvalSummary = {
    fixtures: results.map((r) => ({ name: r.name, matches: r.matches, total: r.total, verdict_match: r.verdict_match, judge_verdict: r.judge.verdict.verdict, expected_verdict: r.entry.human_verdict ?? '', statuses: r.entry.criteria.map((x) => ({ id: x.id, human: x.human, judge: x.judge })) })),
    report,
    criterion_agreement: report.criterion_agreement ?? 0,
    verdict_agreement: report.verdict_agreement ?? 0,
    live: !!opts.live,
    judge_model: results[0]?.judge.judge_model ?? '',
  };
  if (opts.record) fs.writeFileSync(baselineFile(), JSON.stringify({ recorded_at: new Date().toISOString(), judge_model: summary.judge_model, criterion_agreement: summary.criterion_agreement, verdict_agreement: summary.verdict_agreement, fixtures: summary.fixtures.map((f) => ({ name: f.name, matches: f.matches, total: f.total, verdict_match: f.verdict_match })) }, null, 2) + '\n');
  return summary;
}

export function loadBaseline(): { recorded_at?: string; judge_model?: string; criterion_agreement: number; verdict_agreement: number } | null {
  const f = baselineFile();
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8')) as { recorded_at?: string; judge_model?: string; criterion_agreement: number; verdict_agreement: number };
}
