import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isolate, basicFixture, tmpDir } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { StubLlm } from '../src/llm/client.js';
import { intake } from '../src/task/intake.js';
import { judgeSession, computeVerdict, loadJudge, judgeFile } from '../src/judge/judge.js';
import { JudgeSchema } from '../src/judge/schema.js';
import { detectTestCommand, runVerification } from '../src/judge/verify.js';
import { collectGit } from '../src/judge/evidence.js';
import { receiptComment, writeBack } from '../src/judge/writeback.js';
import { renderReport, renderSummary } from '../src/judge/report.js';
import { readEvents, readEventsFile } from '../src/store/events.js';
import type { FetchDeps } from '../src/task/fetchers.js';

let iso: ReturnType<typeof isolate>;
beforeEach(() => {
  iso = isolate();
});
afterEach(() => iso.restore());

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

function makeRepo(opts: { testPasses: boolean }): { cwd: string; base: string } {
  const cwd = tmpDir('tally-judge-repo-');
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.email', 't@t');
  git(cwd, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'acme', scripts: { test: 'node test.js' } }));
  fs.writeFileSync(path.join(cwd, 'test.js'), `process.exit(${opts.testPasses ? 0 : 1})`);
  fs.mkdirSync(path.join(cwd, 'src'));
  fs.writeFileSync(path.join(cwd, 'src', 'login.js'), 'module.exports = () => 200;\n');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', 'base');
  const base = git(cwd, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(cwd, 'src', 'login.js'), 'const limit = require("./rateLimit");\nmodule.exports = () => limit() ? 429 : 200;\n');
  fs.writeFileSync(path.join(cwd, 'src', 'rateLimit.js'), 'module.exports = () => false;\n');
  return { cwd, base };
}

const fixtureEvents = (cwd: string, base: string) =>
  readEventsFile(path.join(basicFixture, 'events.jsonl')).map((e) => (e.type === 'session_start' ? { ...e, cwd, data: { ...e.data, git_head: base } } : { ...e, cwd }));

const judgeStub = (statuses: Array<'met' | 'partial' | 'unmet' | 'unverifiable'>) => ({
  intake: () => ({
    title: 'Rate limit the login endpoint',
    criteria: [
      { text: 'Login returns 429 after 5 failed attempts', source: 'explicit' },
      { text: 'A test covers the 429 path', source: 'explicit' },
      { text: 'README documents the limit', source: 'explicit' },
    ],
    spec_quality: { score: 7, missing: [], questions: [] },
    estimate_hours: 3,
    rationale: 'x',
  }),
  judge: () => ({
    criteria: statuses.map((status, i) => ({ id: `c${i + 1}`, status, evidence: `evidence ${i + 1}`, files: i === 0 ? ['src/login.js'] : [] })),
    quality_score: 7,
    quality_reason: 'Small, tested change.',
    verdict_reason: 'Two of three criteria met at low cost.',
    recommendations: ['Read the README requirement before declaring done.', 'Run the failing test once, then fix.', 'Skip the Jira MCP when it 401s.'],
  }),
});

describe('verification', () => {
  it('detects and runs the project test command with a timeout', async () => {
    const { cwd } = makeRepo({ testPasses: true });
    expect(detectTestCommand(cwd)).toEqual({ command: 'npm test', basis: 'package.json scripts.test' });
    const r = await runVerification(cwd, { timeoutMs: 60000, consent: true });
    expect(r.ran).toBe(true);
    expect(r.passed).toBe(true);
    const bad = makeRepo({ testPasses: false });
    const r2 = await runVerification(bad.cwd, { timeoutMs: 60000, consent: true });
    expect(r2.passed).toBe(false);
    expect(r2.exit_code).toBe(1);
  });
  it('times out a hanging command', async () => {
    const cwd = tmpDir('tally-hang-');
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "setTimeout(()=>{},60000)"' } }));
    const r = await runVerification(cwd, { timeoutMs: 800, consent: true });
    expect(r.ran).toBe(true);
    expect(r.timed_out).toBe(true);
    expect(r.passed).toBe(false);
  });
  it('reports when nothing is detectable', async () => {
    const cwd = tmpDir('tally-empty-');
    expect((await runVerification(cwd, { timeoutMs: 1000, consent: true })).ran).toBe(false);
    expect(detectTestCommand(cwd)).toBeNull();
  });
});

describe('git evidence', () => {
  it('diffs from the session-start HEAD and lists untracked files', () => {
    const { cwd, base } = makeRepo({ testPasses: true });
    const g = collectGit(cwd, base);
    expect(g.files_changed).toEqual(['src/login.js', 'src/rateLimit.js']);
    expect(g.insertions).toBeGreaterThan(0);
    expect(g.diff_excerpt).toContain('rateLimit');
    expect(g.error).toBeUndefined();
    const g2 = collectGit(cwd, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    expect(g2.error).toContain('not found');
  });
});

describe('judge', () => {
  it('produces a validated receipt with cost, waste, value, verdict, and recommendations', async () => {
    const { cwd, base } = makeRepo({ testPasses: true });
    const llm = new StubLlm(judgeStub(['met', 'met', 'unmet']), 'fx');
    const cfg = loadConfig();
    await intake({ session: 'fx', cwd, text: 'Rate limit the login endpoint', cfg, llm, deps: { exec: () => ({ ok: false, stdout: '', stderr: '' }), fetch: async () => ({ ok: false, status: 0, text: async () => '' }), readFile: () => '', exists: () => false } as FetchDeps });
    const j = await judgeSession({ session: 'fx', cwd, transcriptPath: path.join(basicFixture, 'transcript.jsonl'), cfg, llm, reason: 'push', events: fixtureEvents(cwd, base), consent: true });
    expect(JudgeSchema.safeParse(j).success).toBe(true);
    expect(j.completion_pct).toBeCloseTo(66.7, 1);
    expect(j.counts).toEqual({ met: 2, partial: 0, unmet: 1, unverifiable: 0 });
    expect(j.verification.ran).toBe(true);
    expect(j.verification.passed).toBe(true);
    expect(j.cost.total_usd).toBeGreaterThan(0);
    expect(j.cost.by_subagent['agent-explore-01']).toBeTruthy();
    expect(j.cost.by_phase.build!.usd).toBeGreaterThan(0);
    expect(j.cost.per_completed_criterion_usd).toBeCloseTo(j.cost.total_usd / 2, 1);
    expect(j.cost.tally_own_usd).toBeGreaterThan(0);
    expect(j.waste.failed_loops[0]!.repeats).toBe(3);
    expect(j.value.human_value_usd).toBe(225);
    expect(j.value.roi_multiple).toBeGreaterThan(1);
    expect(['worth it', 'borderline', 'not worth it']).toContain(j.verdict.verdict);
    expect(j.recommendations.length).toBe(3);
    expect(j.attribution.label).toBe('correlational');
    expect(j.attribution.rows.find((r) => r.name === 'jira:get_issue')!.errors).toBe(3);
    expect(j.evidence.ship_events.length).toBe(2);
    expect(j.evidence.files_changed).toContain('src/rateLimit.js');
    expect(fs.existsSync(judgeFile('fx'))).toBe(true);
    expect(fs.existsSync(path.join(iso.home, 'sessions', 'fx', 'report.md'))).toBe(true);
    expect(loadJudge('fx')!.session).toBe('fx');
    expect(readEvents('fx').some((e) => e.type === 'judge')).toBe(true);
    const hist = fs.readFileSync(path.join(iso.home, 'history.jsonl'), 'utf8');
    expect(hist).toContain('"verdict"');
    const judgeCall = llm.calls.find((c) => c.kind === 'judge')!;
    expect(judgeCall.system).toContain('skeptical');
    expect(judgeCall.prompt).toContain('INDEPENDENT VERIFICATION');
    expect(judgeCall.prompt).toContain('PASSED');
    expect(judgeCall.prompt).toContain('rateLimit');
    const report = renderReport(j);
    expect(report).toContain('## Verdict');
    expect(report).toContain('correlational');
    expect(renderSummary(j, false)).toContain('Tally receipt');
  });

  it('marks unknown criteria unverifiable and downgrades when independent tests fail', async () => {
    const { cwd, base } = makeRepo({ testPasses: false });
    const llm = new StubLlm({ ...judgeStub(['met', 'met', 'met']), judge: () => ({ criteria: [{ id: 'c1', status: 'met', evidence: 'x', files: [] }], quality_score: 8, quality_reason: 'r', verdict_reason: 'v', recommendations: ['a', 'b', 'c'] }) }, 'fx2');
    const cfg = loadConfig();
    await intake({ session: 'fx2', cwd, text: 'Rate limit', cfg, llm, deps: { exec: () => ({ ok: false, stdout: '', stderr: '' }), fetch: async () => ({ ok: false, status: 0, text: async () => '' }), readFile: () => '', exists: () => false } as FetchDeps });
    const j = await judgeSession({ session: 'fx2', cwd, transcriptPath: path.join(basicFixture, 'transcript.jsonl'), cfg, llm, reason: 'manual', events: fixtureEvents(cwd, base), consent: true });
    expect(j.criteria[1]!.status).toBe('unverifiable');
    expect(j.counts.unverifiable).toBe(2);
    expect(j.verification.passed).toBe(false);
    expect(j.verdict.verdict).not.toBe('worth it');
  });

  it('runs without a linked task using an implicit criterion', async () => {
    const { cwd, base } = makeRepo({ testPasses: true });
    const llm = new StubLlm({ judge: () => ({ criteria: [{ id: 'c1', status: 'partial', evidence: 'x', files: [] }], quality_score: 5, quality_reason: 'r', verdict_reason: 'v', recommendations: ['a'] }) });
    const j = await judgeSession({ session: 'fx3', cwd, transcriptPath: path.join(basicFixture, 'transcript.jsonl'), cfg: loadConfig(), llm, reason: 'session_end', events: fixtureEvents(cwd, base), consent: true });
    expect(j.task.linked).toBe(false);
    expect(j.completion_pct).toBe(50);
    expect(renderReport(j)).toContain('No task was linked');
  });

  it('computes verdicts deterministically', () => {
    expect(computeVerdict({ completion_pct: 100, roi: 5, quality: 8, testsFailed: false })).toBe('worth it');
    expect(computeVerdict({ completion_pct: 100, roi: 5, quality: 8, testsFailed: true })).toBe('borderline');
    expect(computeVerdict({ completion_pct: 60, roi: 3, quality: 7, testsFailed: false })).toBe('borderline');
    expect(computeVerdict({ completion_pct: 30, roi: 3, quality: 7, testsFailed: false })).toBe('not worth it');
    expect(computeVerdict({ completion_pct: 90, roi: 0.5, quality: 7, testsFailed: false })).toBe('not worth it');
    expect(computeVerdict({ completion_pct: 90, roi: null, quality: 7, testsFailed: false })).toBe('worth it');
  });
});

describe('write-back', () => {
  it('posts a compact receipt with no code or prompts to github issue and PR', async () => {
    const { cwd, base } = makeRepo({ testPasses: true });
    const llm = new StubLlm(judgeStub(['met', 'unmet', 'unverifiable']), 'wb');
    const cfg = loadConfig();
    const deps: FetchDeps = { exec: (bin, args) => ({ ok: bin === 'gh' && args[0] === 'issue' && args[1] === 'view', stdout: JSON.stringify({ title: 'Rate limit login', body: 'Block after 5 attempts.', labels: [] }), stderr: 'x' }), fetch: async () => ({ ok: false, status: 0, text: async () => '' }), readFile: () => '', exists: () => false };
    await intake({ session: 'wb', cwd, ref: 'https://github.com/acme/app/issues/42', cfg, llm, deps });
    const j = await judgeSession({ session: 'wb', cwd, transcriptPath: path.join(basicFixture, 'transcript.jsonl'), cfg, llm, reason: 'pr', events: fixtureEvents(cwd, base), consent: true });
    const comment = receiptComment(j);
    expect(comment).toContain('Tally receipt');
    expect(comment).not.toContain('rateLimit(');
    expect(comment).not.toContain('Implement https://github.com');
    const calls: string[][] = [];
    const r = await writeBack(j, cfg, { ...deps, exec: (bin, args) => { calls.push([bin, ...args]); return { ok: true, stdout: '', stderr: '' }; } });
    expect(r.posted.map((p) => p.target).sort()).toEqual(['https://github.com/acme/app/issues/42', 'https://github.com/acme/app/pull/57']);
    expect(calls.some((c) => c[1] === 'issue' && c[2] === 'comment')).toBe(true);
    expect(calls.some((c) => c[1] === 'pr' && c[2] === 'comment')).toBe(true);
  });
});

describe('pattern checks are hints, not verdicts', () => {
  it('sends a diff_contains miss to the judgment tier instead of marking it unmet', async () => {
    const { cwd, base } = makeRepo({ testPasses: true });
    const stub = judgeStub(['met', 'met', 'met']);
    const llm = new StubLlm(
      {
        ...stub,
        intake: () => ({
          ...stub.intake(),
          criteria: [
            { text: 'Login returns 429 after 5 failed attempts', source: 'explicit' },
            { text: 'Tests spawn the CLI end to end', source: 'explicit', check: { kind: 'diff_contains', pattern: 'spawn.*wc2' } },
            { text: 'src/login.js is changed', source: 'explicit', check: { kind: 'file_changed', path: 'src/login.js' } },
          ],
        }),
      },
      'fxpat',
    );
    const cfg = loadConfig();
    await intake({ session: 'fxpat', cwd, text: 'Rate limit the login endpoint', cfg, llm, deps: { exec: () => ({ ok: false, stdout: '', stderr: '' }), fetch: async () => ({ ok: false, status: 0, text: async () => '' }), readFile: () => '', exists: () => false } as FetchDeps });
    const j = await judgeSession({ session: 'fxpat', cwd, transcriptPath: path.join(basicFixture, 'transcript.jsonl'), cfg, llm, reason: 'push', events: fixtureEvents(cwd, base), consent: true });
    const c2 = j.criteria.find((c) => c.id === 'c2')!;
    expect(c2.status).toBe('met');
    expect(c2.resolved_by).not.toBe('tier0');
    const c3 = j.criteria.find((c) => c.id === 'c3')!;
    expect(c3.resolved_by).toBe('tier0');
  });
});

describe('a guessed file path is not evidence of absence', () => {
  it('sends a file_contains check on a missing file to the judgment tier when the session has a diff', async () => {
    const { cwd, base } = makeRepo({ testPasses: true });
    const stub = judgeStub(['met', 'met', 'met']);
    const llm = new StubLlm(
      {
        ...stub,
        intake: () => ({
          ...stub.intake(),
          criteria: [
            { text: 'Login returns 429 after 5 failed attempts', source: 'explicit' },
            { text: 'A test covers the 429 path', source: 'explicit', check: { kind: 'file_contains', path: 'test/login.test.js', pattern: '429' } },
            { text: 'src/login.js is changed', source: 'explicit', check: { kind: 'file_changed', path: 'src/login.js' } },
          ],
        }),
      },
      'fxguess',
    );
    const cfg = loadConfig();
    await intake({ session: 'fxguess', cwd, text: 'Rate limit the login endpoint', cfg, llm, deps: { exec: () => ({ ok: false, stdout: '', stderr: '' }), fetch: async () => ({ ok: false, status: 0, text: async () => '' }), readFile: () => '', exists: () => false } as FetchDeps });
    const j = await judgeSession({ session: 'fxguess', cwd, transcriptPath: path.join(basicFixture, 'transcript.jsonl'), cfg, llm, reason: 'push', events: fixtureEvents(cwd, base), consent: true });
    const c2 = j.criteria.find((c) => c.id === 'c2')!;
    expect(c2.status).toBe('met');
    expect(c2.resolved_by).not.toBe('tier0');
  });
});

describe('what criteria cannot see (0.4)', () => {
  const deps = { exec: () => ({ ok: false, stdout: '', stderr: '' }), fetch: async () => ({ ok: false, status: 0, text: async () => '' }), readFile: () => '', exists: () => false } as FetchDeps;

  it('a regression criterion never resolves from a green suite alone', async () => {
    const { isRegressionCriterion } = await import('../src/judge/judge.js');
    expect(isRegressionCriterion('Existing behaviour is unchanged for other patterns')).toBe(true);
    /* "the suite still passes" is about the run itself, and the run is the right evidence: not a regression claim */
    expect(isRegressionCriterion('The full existing test suite still passes')).toBe(false);
    expect(isRegressionCriterion('No regressions in the parser')).toBe(true);
    expect(isRegressionCriterion('A test covers the 429 path')).toBe(false);
    const { cwd, base } = makeRepo({ testPasses: true });
    const stub = judgeStub(['met', 'unverifiable', 'met']);
    const llm = new StubLlm({ ...stub, intake: () => ({ ...stub.intake(), criteria: [{ text: 'Login returns 429 after 5 failed attempts', source: 'explicit' }, { text: 'Existing login behaviour is unchanged below the limit', source: 'explicit', check: { kind: 'tests_pass' } }, { text: 'The test suite passes', source: 'explicit', check: { kind: 'tests_pass' } }] }) }, 'fxreg');
    const cfg = loadConfig();
    await intake({ session: 'fxreg', cwd, text: 'Rate limit', cfg, llm, deps });
    const j = await judgeSession({ session: 'fxreg', cwd, transcriptPath: path.join(basicFixture, 'transcript.jsonl'), cfg, llm, reason: 'push', events: fixtureEvents(cwd, base), consent: true });
    const c2 = j.criteria.find((c) => c.id === 'c2')!;
    expect(c2.resolved_by).not.toBe('tier0');
    expect(c2.status).toBe('unverifiable');
    expect(j.criteria.find((c) => c.id === 'c3')!.resolved_by).toBe('tier0');
  });

  it('a spec that needed clarification and was never confirmed holds the verdict at borderline', async () => {
    const { computeVerdict } = await import('../src/judge/judge.js');
    expect(computeVerdict({ completion_pct: 100, roi: 50, quality: 8, testsFailed: false, verifiable: 3 })).toBe('worth it');
    expect(computeVerdict({ completion_pct: 100, roi: 50, quality: 8, testsFailed: false, verifiable: 3, specCapped: true })).toBe('borderline');
    expect(computeVerdict({ completion_pct: 30, roi: 50, quality: 8, testsFailed: false, verifiable: 3, specCapped: true })).toBe('not worth it');
    const { cwd, base } = makeRepo({ testPasses: true });
    const stub = judgeStub(['met', 'met', 'met']);
    const llm = new StubLlm({ ...stub, intake: () => ({ ...stub.intake(), spec_quality: { score: 2, missing: ['what better means'], questions: ['Which log levels?'] } }) }, 'fxvague');
    const cfg = loadConfig();
    cfg.judge.maintainer_review = 'off';
    await intake({ session: 'fxvague', cwd, text: 'make the logger better', cfg, llm, deps });
    const j = await judgeSession({ session: 'fxvague', cwd, transcriptPath: path.join(basicFixture, 'transcript.jsonl'), cfg, llm, reason: 'push', events: fixtureEvents(cwd, base), consent: true });
    expect(j.completion_pct).toBe(100);
    expect(j.task.spec_capped).toBe(true);
    expect(j.verdict.verdict).toBe('borderline');
    expect(j.verdict.reason).toContain('never confirmed');
  });

  it('the maintainer review can hold a fully met change at borderline, and says why', async () => {
    const { cwd, base } = makeRepo({ testPasses: true });
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'acme-lib', main: 'src/login.js', scripts: { test: JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')).scripts.test } }));
    const stub = judgeStub(['met', 'met', 'met']);
    const llm = new StubLlm({ ...stub, intake: () => ({ ...stub.intake(), spec_quality: { score: 8, missing: [], questions: [] } }), review: () => ({ layer: 'workaround', layer_note: 'patches around the router dependency', blast_radius: 'contained', blast_note: '', untested_surface: ['array mount paths'], merge: 'request_changes', note: 'fix belongs upstream' }) }, 'fxrev');
    const cfg = loadConfig();
    await intake({ session: 'fxrev', cwd, text: 'Rate limit the login endpoint', cfg, llm, deps });
    const j = await judgeSession({ session: 'fxrev', cwd, transcriptPath: path.join(basicFixture, 'transcript.jsonl'), cfg, llm, reason: 'push', events: fixtureEvents(cwd, base), consent: true });
    expect(j.review?.ran).toBe(true);
    expect(j.review?.merge).toBe('request_changes');
    expect(j.completion_pct).toBe(100);
    expect(j.verdict.verdict).toBe('borderline');
    expect(j.verdict.reason).toContain('maintainer review');
    expect(renderReport(j)).toContain('REQUEST CHANGES');
    /* a stub without a review responder degrades to "not run", never to a crash */
    const llm2 = new StubLlm(stub, 'fxrev2');
    await intake({ session: 'fxrev2', cwd, text: 'Rate limit the login endpoint', cfg, llm: llm2, deps });
    const j2 = await judgeSession({ session: 'fxrev2', cwd, transcriptPath: path.join(basicFixture, 'transcript.jsonl'), cfg, llm: llm2, reason: 'push', events: fixtureEvents(cwd, base), consent: true });
    expect(j2.review?.ran).toBe(false);
    expect(j2.verdict.verdict).toBe('worth it');
  });

  it('dead-weight context is reported as setup cost, not counted in waste', async () => {
    const { cwd, base } = makeRepo({ testPasses: true });
    const llm = new StubLlm(judgeStub(['met', 'met', 'met']), 'fxdw');
    const cfg = loadConfig();
    cfg.judge.maintainer_review = 'off';
    await intake({ session: 'fxdw', cwd, text: 'Rate limit the login endpoint', cfg, llm, deps });
    const j = await judgeSession({ session: 'fxdw', cwd, transcriptPath: path.join(basicFixture, 'transcript.jsonl'), cfg, llm, reason: 'push', events: fixtureEvents(cwd, base), consent: true });
    const parts = j.waste.failed_loops.reduce((s, x) => s + x.usd, 0) + j.waste.repeated_reads.reduce((s, x) => s + x.usd, 0) + j.waste.compaction_churn.usd;
    expect(j.waste.total_usd).toBeCloseTo(parts, 3);
    expect(j.waste.dead_weight.usd).toBeGreaterThan(0);
    expect(renderReport(j)).toContain('Setup cost');
  });
});
