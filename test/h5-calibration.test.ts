import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isolate, basicFixture, tmpDir, root } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { StubLlm } from '../src/llm/client.js';
import { intake } from '../src/task/intake.js';
import { judgeSession } from '../src/judge/judge.js';
import { readEventsFile } from '../src/store/events.js';
import { addCalibration, buildCalibrationReport, parseStatuses, parseVerdict, readCalibration, renderCalibrationReport } from '../src/calibrate/calibrate.js';
import { loadFixtures, runEval, runFixture, loadBaseline } from '../src/calibrate/eval.js';
import type { FetchDeps } from '../src/task/fetchers.js';

let iso: ReturnType<typeof isolate>;
beforeEach(() => {
  iso = isolate();
});
afterEach(() => iso.restore());

const noFetch: FetchDeps = { exec: () => ({ ok: false, stdout: '', stderr: '' }), fetch: async () => ({ ok: false, status: 0, text: async () => '' }), readFile: () => '', exists: () => false };

describe('H5 calibrate add/report', () => {
  it('stores human grades against a receipt and reports agreement, confusion, and disagreements', async () => {
    const cwd = tmpDir('tally-cal-');
    const git = (...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    fs.writeFileSync(path.join(cwd, 'a.js'), '1');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    const base = git('rev-parse', 'HEAD').stdout.trim();
    const llm = new StubLlm(
      {
        intake: () => ({ title: 'T', criteria: [{ text: 'a', source: 'explicit' }, { text: 'b', source: 'explicit' }, { text: 'c', source: 'explicit' }], spec_quality: { score: 7, missing: [], questions: [] }, estimate_hours: 1, rationale: '' }),
        judge: () => ({ criteria: [{ id: 'c1', status: 'met', evidence: 'e1', files: [] }, { id: 'c2', status: 'met', evidence: 'e2', files: [] }, { id: 'c3', status: 'unverifiable', evidence: 'e3', files: [] }], quality_score: 7, quality_reason: 'r', verdict_reason: 'v', recommendations: ['a', 'b', 'c'] }),
      },
      'cal1',
    );
    await intake({ session: 'cal1', cwd, text: 'T', cfg: loadConfig(), llm, deps: noFetch });
    const events = readEventsFile(path.join(basicFixture, 'events.jsonl')).map((e) => (e.type === 'session_start' ? { ...e, cwd, data: { ...e.data, git_head: base } } : { ...e, cwd }));
    await judgeSession({ session: 'cal1', cwd, transcriptPath: path.join(basicFixture, 'transcript.jsonl'), cfg: loadConfig(), llm, reason: 'manual', events, verification: { ran: false, reason: 'x' } });
    expect(parseStatuses('met, partial,unm')).toEqual(['met', 'partial', 'unmet']);
    expect(parseVerdict('not worth')).toBe('not worth it');
    expect(() => parseStatuses('bogus')).toThrow();
    expect(() => addCalibration('cal1', ['met'])).toThrow(/expected 3 grade/);
    const entry = addCalibration('cal1', ['met', 'unmet', 'unverifiable'], 'borderline');
    expect(entry.criteria.map((c) => c.judge)).toEqual(['met', 'met', 'unverifiable']);
    const entries = readCalibration();
    expect(entries.length).toBe(1);
    const r = buildCalibrationReport(entries);
    expect(r.criteria).toBe(3);
    expect(r.criterion_agreement).toBeCloseTo(2 / 3, 6);
    expect(r.confusion.unmet.met).toBe(1);
    expect(r.confusion.met.met).toBe(1);
    expect(r.disagreements.length).toBe(1);
    expect(r.disagreements[0]!.evidence).toBe('e2');
    expect(r.verdict_total).toBe(1);
    expect(r.per_status.met.precision).toBe(0.5);
    const text = renderCalibrationReport(r);
    expect(text).toContain('confusion (rows = human, columns = judge)');
    expect(text).toContain('human unmet, judge met');
    const cli = spawnSync(process.execPath, [path.join(root, 'dist', 'cli.js'), 'calibrate', 'report'], { encoding: 'utf8', env: { ...process.env } });
    expect(cli.stdout).toContain('1 graded session');
  });
});

describe('H5 fixture eval', () => {
  it('loads five fixture sessions with known answers', () => {
    const cases = loadFixtures();
    expect(cases.map((c) => c.name)).toEqual(['claims-no-tests', 'health-endpoint-complete', 'rate-limit-partial', 'scope-creep', 'wrong-fix-tests-fail']);
    for (const c of cases) {
      expect(Object.keys(c.expected.criteria).length).toBe(c.task.criteria.length);
      expect(fs.existsSync(path.join(c.dir, 'transcript.jsonl'))).toBe(true);
      expect(c.recorded, `${c.name} needs model-output.json (tally calibrate eval --live --record)`).toBeTruthy();
    }
  });

  it('replays recorded model output through the real pipeline and agrees with the baseline', async () => {
    const s = await runEval({ cfg: loadConfig() });
    expect(s.fixtures.length).toBe(5);
    const baseline = loadBaseline();
    expect(baseline).toBeTruthy();
    expect(s.criterion_agreement).toBeGreaterThanOrEqual(baseline!.criterion_agreement - 1e-9);
    expect(s.verdict_agreement).toBeGreaterThanOrEqual(baseline!.verdict_agreement - 1e-9);
    const wrong = s.fixtures.find((f) => f.name === 'wrong-fix-tests-fail')!;
    expect(wrong.judge_verdict).toBe('not worth it');
    const done = s.fixtures.find((f) => f.name === 'health-endpoint-complete')!;
    expect(done.judge_verdict).toBe('worth it');
  }, 120000);

  it('a deliberately wrong model answer lowers agreement and fails the threshold', async () => {
    const c = loadFixtures().find((x) => x.name === 'health-endpoint-complete')!;
    const bad = new StubLlm({ judge: () => ({ criteria: c.task.criteria.map((cr) => ({ id: cr.id, status: 'unmet', evidence: 'nope', files: [] })), quality_score: 2, quality_reason: 'r', verdict_reason: 'v', recommendations: ['a'] }) }, 'x');
    const r = await runFixture(c, { cfg: loadConfig(), llm: bad });
    const judged = r.judge.criteria.filter((x) => x.resolved_by !== 'tier0');
    expect(judged.length).toBeGreaterThan(0);
    expect(judged.every((x) => x.status === 'unmet')).toBe(true);
    expect(r.judge.criteria.filter((x) => x.resolved_by === 'tier0').every((x) => x.status === 'met')).toBe(true);
    expect(r.matches).toBe(r.total - judged.length);
    expect(r.judge.verdict.verdict).toBe('not worth it');
    expect(r.verdict_match).toBe(false);
  }, 60000);
});
