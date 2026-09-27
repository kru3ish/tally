import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isolate, tmpDir, root, basicFixture } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { StubLlm } from '../src/llm/client.js';
import { intake, loadTask, confirmTask } from '../src/task/intake.js';
import { judgeSession } from '../src/judge/judge.js';
import type { FetchDeps } from '../src/task/fetchers.js';
import { readEventsFile } from '../src/store/events.js';
import { buildAssurance, criterionKeywords, parsePassedCount, renderVerify, statusFromJudge } from '../src/assurance/index.js';
import { normalizeSession, countEvents, modelIdentity } from '../src/core/events.js';
import { contractFromTask, renderContract, contractFile } from '../src/core/contract.js';
import { parseTranscriptFile } from '../src/transcript/parse.js';
import { renderSummary } from '../src/judge/report.js';

const CLI = path.join(root, 'dist', 'cli.js');

let iso: ReturnType<typeof isolate>;
beforeEach(() => {
  iso = isolate();
});
afterEach(() => iso.restore());

function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_EMAIL: 't@t', GIT_AUTHOR_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_COMMITTER_NAME: 't' } });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

/* a repo with one pre-existing test; the "agent" then changes src/login.js and adds a test that names the 429 behaviour */
function makeRepo(opts: { agentAddsTest: boolean; testPasses?: boolean }): { cwd: string; base: string } {
  const cwd = tmpDir('tally-assure-');
  git(cwd, ['init', '-q', '-b', 'main']);
  fs.mkdirSync(path.join(cwd, 'src'));
  fs.mkdirSync(path.join(cwd, 'test'));
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'app', scripts: { test: `node test/run.js` } }));
  fs.writeFileSync(path.join(cwd, 'src', 'login.js'), 'module.exports = function login() { return 200; };\n');
  fs.writeFileSync(path.join(cwd, 'test', 'run.js'), `const fs = require('fs'); for (const f of fs.readdirSync(__dirname)) if (f.endsWith('.test.js')) require('./' + f); console.log('2 passing');${opts.testPasses === false ? ' process.exit(1);' : ''}\n`);
  fs.writeFileSync(path.join(cwd, 'test', 'existing.test.js'), "it = (n, f) => f(); it('login returns 200', () => { if (require('../src/login.js')() !== 200) throw new Error('x'); });\n");
  fs.writeFileSync(path.join(cwd, 'README.md'), '# app\n');
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '-m', 'base']);
  const base = git(cwd, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(cwd, 'src', 'login.js'), 'let attempts = 0;\nmodule.exports = function login() { attempts += 1; return attempts > 5 ? 429 : 200; };\n');
  if (opts.agentAddsTest) fs.writeFileSync(path.join(cwd, 'test', 'ratelimit.test.js'), "const it = (n, f) => f();\nit('returns 429 after five failed attempts', () => { const login = require('../src/login.js'); for (let i = 0; i < 5; i++) login(); if (login() !== 429) throw new Error('no 429'); });\n");
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '-m', 'agent work']);
  return { cwd, base };
}

const fixtureEvents = (cwd: string, base: string) => readEventsFile(path.join(basicFixture, 'events.jsonl')).map((e) => (e.type === 'session_start' ? { ...e, cwd, data: { ...e.data, git_head: base } } : { ...e, cwd }));
const deps = { exec: () => ({ ok: false, stdout: '', stderr: '' }), fetch: async () => ({ ok: false, status: 0, text: async () => '' }), readFile: () => '', exists: () => false } as FetchDeps;

const stubFor = (statuses: Array<'met' | 'partial' | 'unmet' | 'unverifiable'>) => ({
  intake: () => ({
    title: 'Rate limit the login endpoint',
    criteria: [
      { text: 'Login returns 429 after 5 failed attempts', source: 'explicit' },
      { text: 'Existing login behaviour is unchanged below the limit', source: 'explicit' },
      { text: 'README documents the limit', source: 'explicit', check: { kind: 'file_changed', path: 'README.md' } },
    ],
    spec_quality: { score: 8, missing: [], questions: [] },
    estimate_hours: 2,
    rationale: 'x',
    constraints: ['Do not replace the auth provider'],
  }),
  judge: () => ({ criteria: statuses.map((status, i) => ({ id: `c${i + 1}`, status, evidence: `model evidence ${i + 1}`, files: i === 0 ? ['src/login.js'] : [], confidence: 0.9 })), quality_score: 7, quality_reason: 'r', verdict_reason: 'v', recommendations: ['a', 'b', 'c'] }),
  review: () => ({ layer: 'at_root_cause', layer_note: '', blast_radius: 'contained', blast_note: '', untested_surface: [], merge: 'merge', note: '' }),
});

describe('normalised events', () => {
  it('projects raw hook events and the transcript into one vendor-neutral stream with agent and model separated', () => {
    const raw = readEventsFile(path.join(basicFixture, 'events.jsonl'));
    const t = parseTranscriptFile(path.join(basicFixture, 'transcript.jsonl'));
    const ev = normalizeSession(raw, t);
    expect(ev[0]!.type).toBe('session_started');
    expect(ev[0]!.agent.product).toBe('claude-code');
    expect(ev.some((e) => e.type === 'command_started' && e.command?.includes('npm test'))).toBe(true);
    expect(ev.some((e) => e.type === 'test_finished')).toBe(true);
    expect(ev.some((e) => e.type === 'file_edit' && e.file)).toBe(true);
    expect(ev.some((e) => e.type === 'model_usage' && e.tokens && (e.cost_usd ?? 0) >= 0)).toBe(true);
    const usage = ev.find((e) => e.type === 'model_usage')!;
    expect(usage.model?.provider).toBe('anthropic');
    expect(usage.source.rawType).toBe('transcript:assistant');
    const counts = countEvents(ev);
    expect(counts.prompts).toBeGreaterThan(0);
    expect(counts.test_runs).toBeGreaterThan(0);
    expect(counts.cost_usd).toBeGreaterThan(0);
    for (let i = 1; i < ev.length; i++) expect(ev[i]!.timestamp >= ev[i - 1]!.timestamp).toBe(true);
  });

  it('resolves model identity from the model string and never guesses a provider it does not know', () => {
    expect(modelIdentity('claude-sonnet-5')).toMatchObject({ provider: 'anthropic', family: 'claude' });
    expect(modelIdentity('gpt-5.3-codex')).toMatchObject({ provider: 'openai', family: 'gpt' });
    expect(modelIdentity('o4-mini')).toMatchObject({ provider: 'openai', family: 'o-series' });
    expect(modelIdentity('gemini-2.5-pro')).toMatchObject({ provider: 'google' });
    expect(modelIdentity('local:llama3')).toMatchObject({ provider: 'local' });
    expect(modelIdentity('mystery-9')).toMatchObject({ provider: 'unknown' });
    expect(modelIdentity(undefined)).toBeUndefined();
  });

  it('leaves cost absent, not zero, when no usage was observed', () => {
    const raw = readEventsFile(path.join(basicFixture, 'events.jsonl'));
    const counts = countEvents(normalizeSession(raw, null));
    expect(counts.cost_usd).toBeUndefined();
    expect(counts.usage).toBeUndefined();
  });
});

describe('task contract', () => {
  it('projects the frozen task with constraints, verification commands, unknowns, status and revisions', async () => {
    const { cwd } = makeRepo({ agentAddsTest: true });
    const llm = new StubLlm(stubFor(['met', 'met', 'unmet']), 'contract-1');
    await intake({ session: 'contract-1', cwd, text: 'Rate limit the login endpoint', cfg: loadConfig(), llm, deps });
    let c = contractFromTask(loadTask('contract-1')!, { cwd });
    expect(c.goal).toBe('Rate limit the login endpoint');
    expect(c.criteria.length).toBe(3);
    expect(c.constraints).toEqual(['Do not replace the auth provider']);
    expect(c.verification).toEqual(['npm test']);
    /* a task typed as text has no ticket behind it: inferred, so it needs confirmation until someone confirms */
    expect(c.status).toBe('needs_confirmation');
    expect(c.revisions.map((r) => r.kind)).toEqual(['created']);
    confirmTask('contract-1');
    c = contractFromTask(loadTask('contract-1')!, { cwd });
    expect(c.status).toBe('confirmed');
    expect(c.revisions.map((r) => r.kind)).toEqual(['created', 'confirmed']);
    expect(fs.existsSync(contractFile('contract-1'))).toBe(true);
    const text = renderContract(c);
    expect(text).toContain('TASK CONTRACT');
    expect(text).toContain('[ ] c3 README documents the limit');
    expect(text).toContain('Do not replace the auth provider');
    expect(text).toContain('Status: CONFIRMED');
  });

  it('an inferred task needs confirmation until someone confirms it', async () => {
    const { cwd } = makeRepo({ agentAddsTest: false });
    const llm = new StubLlm(stubFor(['met', 'met', 'unmet']), 'contract-2');
    await intake({ session: 'contract-2', cwd, text: 'make login better', cfg: loadConfig(), llm, deps, context: { branch: 'x', commits: [] } });
    const t = loadTask('contract-2')!;
    if (t.inferred) expect(contractFromTask(t, { cwd }).status).toBe('needs_confirmation');
  });
});

describe('assurance engine', () => {
  it('maps deterministic checks to VERIFIED, model-only reads to SUPPORTED, and a missing README to UNMET', async () => {
    const { cwd, base } = makeRepo({ agentAddsTest: false });
    const llm = new StubLlm(stubFor(['met', 'met', 'unmet']), 'assure-1');
    const cfg = loadConfig();
    cfg.judge.maintainer_review = 'off';
    await intake({ session: 'assure-1', cwd, text: 'Rate limit the login endpoint', cfg, llm, deps });
    const j = await judgeSession({ session: 'assure-1', cwd, transcriptPath: path.join(basicFixture, 'transcript.jsonl'), cfg, llm, reason: 'push', events: fixtureEvents(cwd, base), consent: true });
    const a = j.assurance!;
    expect(a.schema).toBe('tally.verify.v1');
    const by = Object.fromEntries(a.criteria.map((c) => [c.id, c]));
    /* c1: the model said met and src/login.js changed, but no test names the behaviour: supported, not verified */
    expect(by.c1!.status).toBe('SUPPORTED');
    expect(by.c1!.evidence.some((e) => e.kind === 'file_changed' && e.ref === 'src/login.js')).toBe(true);
    expect(by.c1!.evidence.some((e) => e.kind === 'model_judgment' && e.strength === 'interpreted')).toBe(true);
    /* c3: a file_changed check on README, deterministic and negative */
    expect(by.c3!.status).toBe('UNMET');
    expect(by.c3!.basis).toBe('deterministic');
    expect(a.summary).toMatchObject({ unmet: 1, total: 3 });
    expect(a.verification.preexisting_files).toBe(2);
    expect(a.verification.agent_created.added_files).toEqual([]);
    expect(a.verification.independent.ran).toBe(true);
    expect(a.verification.independent.total_passed).toBe(2);
    expect(a.agent.product).toBe('claude-code');
    expect(a.model?.provider).toBe('anthropic');
  });

  it('a test the agent added that names the behaviour, plus a green independent run, verifies a behavioural criterion', async () => {
    const { cwd, base } = makeRepo({ agentAddsTest: true });
    const llm = new StubLlm(stubFor(['met', 'met', 'unmet']), 'assure-2');
    const cfg = loadConfig();
    cfg.judge.maintainer_review = 'off';
    await intake({ session: 'assure-2', cwd, text: 'Rate limit the login endpoint', cfg, llm, deps });
    const j = await judgeSession({ session: 'assure-2', cwd, transcriptPath: path.join(basicFixture, 'transcript.jsonl'), cfg, llm, reason: 'push', events: fixtureEvents(cwd, base), consent: true });
    const a = j.assurance!;
    const c1 = a.criteria.find((c) => c.id === 'c1')!;
    expect(c1.status).toBe('VERIFIED');
    expect(c1.basis).toBe('deterministic+model');
    expect(c1.evidence.some((e) => e.kind === 'test_added' && e.ref === 'test/ratelimit.test.js')).toBe(true);
    expect(c1.evidence.some((e) => e.kind === 'diff_hunk' && e.ref?.startsWith('test/ratelimit.test.js'))).toBe(true);
    expect(c1.evidence.some((e) => e.kind === 'independent_run' && e.ok)).toBe(true);
    expect(a.verification.agent_created.added_files).toEqual(['test/ratelimit.test.js']);
    expect(a.verification.agent_created.cases_added).toBe(1);
    /* the receipt summary leads with the evidence map, not the verdict */
    const summary = renderSummary(j, false);
    expect(summary.split('\n')[2]).toContain('criteria have sufficient evidence');
    expect(summary).toContain('✓ VERIFIED');
    expect(summary).toContain('✗ UNMET');
    expect(summary.indexOf('Experimental')).toBeGreaterThan(summary.indexOf('UNMET'));
    const text = renderVerify(a, { color: false });
    expect(text).toContain('Tally Verify');
    expect(text).toContain('✓ VERIFIED    Login returns 429');
    expect(text).toContain('✗ UNMET       README documents the limit');
    expect(text).toContain('pre-existing tests: 2 file(s)');
    expect(text).toContain('agent-created tests: 1 file(s) added');
  });

  it('a failed independent run cannot verify anything and a regression claim without evidence is UNVERIFIED', async () => {
    const { cwd, base } = makeRepo({ agentAddsTest: true, testPasses: false });
    const llm = new StubLlm(stubFor(['met', 'unverifiable', 'unmet']), 'assure-3');
    const cfg = loadConfig();
    cfg.judge.maintainer_review = 'off';
    await intake({ session: 'assure-3', cwd, text: 'Rate limit the login endpoint', cfg, llm, deps });
    const j = await judgeSession({ session: 'assure-3', cwd, transcriptPath: path.join(basicFixture, 'transcript.jsonl'), cfg, llm, reason: 'push', events: fixtureEvents(cwd, base), consent: true });
    const a = j.assurance!;
    expect(a.criteria.find((c) => c.id === 'c1')!.status).toBe('SUPPORTED');
    expect(a.criteria.find((c) => c.id === 'c2')!.status).toBe('UNVERIFIED');
    expect(a.verification.independent.passed).toBe(false);
  });

  it('old receipts map through statusFromJudge without git', () => {
    const base = { id: 'c1', text: 't', evidence: 'e', files: [] as string[] };
    expect(statusFromJudge({ ...base, status: 'met', resolved_by: 'tier0' })).toBe('VERIFIED');
    expect(statusFromJudge({ ...base, status: 'met', resolved_by: 'tier1' })).toBe('SUPPORTED');
    expect(statusFromJudge({ ...base, status: 'partial', resolved_by: 'tier2' })).toBe('SUPPORTED');
    expect(statusFromJudge({ ...base, status: 'unverifiable', resolved_by: 'rule' })).toBe('UNVERIFIED');
    expect(statusFromJudge({ ...base, status: 'unmet', resolved_by: 'tier1' })).toBe('UNMET');
    expect(statusFromJudge({ ...base, status: 'unmet', resolved_by: 'tier1', override: { status: 'met', reason: 'r', by: 'me', ts: 't', original: 'unmet' } })).toBe('SUPPORTED');
  });

  it('keyword and passed-count helpers', () => {
    expect(criterionKeywords('POST /api/login returns 429 after 5 attempts; see src/rateLimit.ts and `retryAfter`')).toEqual(expect.arrayContaining(['429', 'src/rateLimit.ts', 'retryAfter']));
    expect(parsePassedCount('  1263 passing (3s)')).toBe(1263);
    expect(parsePassedCount('ℹ tests 7\nℹ pass 7\nℹ fail 0')).toBe(7);
    expect(parsePassedCount('Tests:       5 passed, 5 total')).toBe(5);
    expect(parsePassedCount('# pass  1156')).toBe(1156);
    expect(parsePassedCount('nothing here')).toBeNull();
  });

  it('tally verify --json emits the schema and --ci exits 1 on an UNMET criterion', async () => {
    const { cwd, base } = makeRepo({ agentAddsTest: true });
    const llm = new StubLlm(stubFor(['met', 'met', 'unmet']), 'assure-4');
    const cfg = loadConfig();
    cfg.judge.maintainer_review = 'off';
    await intake({ session: 'assure-4', cwd, text: 'Rate limit the login endpoint', cfg, llm, deps });
    await judgeSession({ session: 'assure-4', cwd, transcriptPath: path.join(basicFixture, 'transcript.jsonl'), cfg, llm, reason: 'push', events: fixtureEvents(cwd, base), consent: true });
    const json = spawnSync(process.execPath, [CLI, 'verify', 'assure-4', '--json'], { cwd, encoding: 'utf8', env: { ...process.env, TALLY_LLM: 'stub' } });
    expect(json.status).toBe(0);
    const doc = JSON.parse(json.stdout) as { schema: string; summary: { unmet: number } };
    expect(doc.schema).toBe('tally.verify.v1');
    expect(doc.summary.unmet).toBe(1);
    const ci = spawnSync(process.execPath, [CLI, 'verify', 'assure-4', '--ci'], { cwd, encoding: 'utf8', env: { ...process.env, TALLY_LLM: 'stub' } });
    expect(ci.status).toBe(1);
    expect(ci.stderr).toContain('UNMET');
    expect(ci.stdout).toContain('Tally Verify');
  });
});

describe('adversarial rules', () => {
  it('a runner that runs nothing is inconclusive; a real runner with output is conclusive', async () => {
    const { runLooksConclusive } = await import('../src/judge/checks.js');
    const cwd = tmpDir('tally-runner-');
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'echo ok' } }));
    expect(runLooksConclusive('ok', cwd, 'npm test')).toBe(false);
    expect(runLooksConclusive('', cwd, 'node test.js')).toBe(false);
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node test.js' } }));
    expect(runLooksConclusive('ok', cwd, 'npm test')).toBe(true);
    expect(runLooksConclusive('1 passing', cwd, 'npm test')).toBe(true);
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'exit 0' } }));
    expect(runLooksConclusive('anything', cwd, 'npm test')).toBe(false);
  });

  it('a "test covers X" criterion with no test evidence is UNVERIFIED even when the model says met', async () => {
    const { cwd, base } = makeRepo({ agentAddsTest: false });
    /* the model claims a test covers the behaviour; no test file changed and none names 429 */
    const llm = new StubLlm(stubFor(['met', 'met', 'unmet']), 'assure-adv');
    const cfg = loadConfig();
    cfg.judge.maintainer_review = 'off';
    const stub = stubFor(['met', 'met', 'unmet']);
    const llm2 = new StubLlm({ ...stub, intake: () => ({ ...stub.intake(), criteria: [{ text: 'Login returns 429 after 5 failed attempts', source: 'explicit' }, { text: 'A test covers the 429 path', source: 'explicit' }, { text: 'README documents the limit', source: 'explicit', check: { kind: 'file_changed', path: 'README.md' } }] }) }, 'assure-adv');
    void llm;
    await intake({ session: 'assure-adv', cwd, text: 'Rate limit the login endpoint', cfg, llm: llm2, deps });
    const j = await judgeSession({ session: 'assure-adv', cwd, transcriptPath: path.join(basicFixture, 'transcript.jsonl'), cfg, llm: llm2, reason: 'push', events: fixtureEvents(cwd, base), consent: true });
    const c2 = j.assurance!.criteria.find((c) => c.id === 'c2')!;
    expect(c2.judge_status).toBe('met');
    expect(c2.status).toBe('UNVERIFIED');
    expect(c2.evidence.some((e) => e.kind === 'test_names_it' && e.ok === false)).toBe(true);
  });
});
