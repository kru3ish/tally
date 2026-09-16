import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isolate, basicFixture, tmpDir } from './helpers.js';
import { loadConfig, setTestRerunConsent, testRerunConsent } from '../src/config.js';
import { runVerification, scrubEnv, NO_CONSENT_REASON } from '../src/judge/verify.js';
import { judgeSession, isTestCriterion } from '../src/judge/judge.js';
import { receiptComment, writeBack } from '../src/judge/writeback.js';
import { StubLlm } from '../src/llm/client.js';
import { intake } from '../src/task/intake.js';
import { readEventsFile } from '../src/store/events.js';
import { verificationConsent } from '../src/coach/rules/verification-consent.js';
import { applySuggestion, skipSuggestion } from '../src/coach/actions.js';
import { buildContext } from '../src/coach/context.js';
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

const SECRET_DIFF = 'sk-ant-api03-DIFFSECRETDIFFSECRETDIFFSECRET';
const SECRET_MSG = 'ghp_MSGSECRETMSGSECRETMSGSECRET1234';

function repo(): { cwd: string; base: string } {
  const cwd = tmpDir('tally-h2-');
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.email', 't@t');
  git(cwd, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node test.js' } }));
  fs.writeFileSync(path.join(cwd, 'test.js'), 'process.stdout.write("SECRET_SEEN=" + (process.env.MY_API_TOKEN || process.env.ANTHROPIC_API_KEY || "none") + " HOME_OK=" + (!!(process.env.HOME || process.env.USERPROFILE)) + " PATH_OK=" + !!process.env.PATH); process.exit(0)');
  fs.writeFileSync(path.join(cwd, 'a.js'), '1');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', 'base');
  const base = git(cwd, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(cwd, 'a.js'), `const KEY = "${SECRET_DIFF}";\nmodule.exports = KEY;\n`);
  return { cwd, base };
}

const noFetch: FetchDeps = { exec: () => ({ ok: false, stdout: '', stderr: '' }), fetch: async () => ({ ok: false, status: 0, text: async () => '' }), readFile: () => '', exists: () => false };
const llmFor = (session: string) =>
  new StubLlm(
    {
      intake: () => ({ title: 'Ship it', criteria: [{ text: 'Endpoint returns 429 above the limit', source: 'explicit' }, { text: 'Tests pass for the limiter', source: 'explicit' }, { text: 'README documents the limit', source: 'explicit' }], spec_quality: { score: 7, missing: [], questions: [] }, estimate_hours: 2, rationale: '' }),
      judge: () => ({
        criteria: [
          { id: 'c1', status: 'met', evidence: `a.js sets KEY = "${SECRET_DIFF}" and returns 429`, files: ['a.js'] },
          { id: 'c2', status: 'met', evidence: 'assistant said tests pass', files: [] },
          { id: 'c3', status: 'unmet', evidence: 'README unchanged', files: [] },
        ],
        quality_score: 6,
        quality_reason: `token ${SECRET_MSG} appears in the messages`,
        verdict_reason: `fine, though ${SECRET_MSG} leaked`,
        recommendations: ['a', 'b', 'c'],
      }),
    },
    session,
  );

describe('H2 consent', () => {
  it('without consent tests are not run and test criteria become unverifiable with the stated reason', async () => {
    const { cwd, base } = repo();
    const cfg = loadConfig();
    expect(testRerunConsent(cfg, cwd)).toBeUndefined();
    const llm = llmFor('h2a');
    await intake({ session: 'h2a', cwd, text: 'x', cfg, llm, deps: noFetch });
    const events = readEventsFile(path.join(basicFixture, 'events.jsonl')).map((e) => (e.type === 'session_start' ? { ...e, cwd, data: { ...e.data, git_head: base } } : { ...e, cwd }));
    const j = await judgeSession({ session: 'h2a', cwd, transcriptPath: path.join(basicFixture, 'transcript.jsonl'), cfg, llm, reason: 'manual', events });
    expect(j.verification.ran).toBe(false);
    expect(j.verification.reason).toBe(NO_CONSENT_REASON);
    expect(j.criteria[0]!.status).toBe('met');
    expect(j.criteria[1]!.status).toBe('unverifiable');
    expect(j.criteria[1]!.evidence).toContain('unverifiable (tests not run: no consent)');
    expect(j.criteria[2]!.status).toBe('unmet');
    const judgeCall = llm.calls.find((c) => c.kind === 'judge')!;
    expect(judgeCall.prompt).toContain('has not allowed the auditor to run tests');
    expect(isTestCriterion('A test covers the 429 path')).toBe(true);
    expect(isTestCriterion('README documents the limit')).toBe(false);
  });

  it('with consent the re-run happens with a scrubbed environment and the command is recorded', async () => {
    const { cwd } = repo();
    setTestRerunConsent(cwd, true);
    expect(testRerunConsent(loadConfig(), cwd)).toBe(true);
    process.env.MY_API_TOKEN = 'supersecret';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-xyz';
    process.env.TALLY_FRIENDLY = 'x';
    const r = await runVerification(cwd, { timeoutMs: 30000, consent: true });
    delete process.env.MY_API_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.TALLY_FRIENDLY;
    expect(r.ran).toBe(true);
    expect(r.env_scrubbed).toBe(true);
    expect(r.command).toBe('npm test');
    expect(r.output_tail).toContain('SECRET_SEEN=none');
    expect(r.output_tail).toContain('HOME_OK=true');
    expect(r.output_tail).toContain('PATH_OK=true');
    const env = scrubEnv({ PATH: '/bin', HOME: '/h', MY_SECRET: 'x', GITHUB_TOKEN: 'y', DATABASE_URL: 'z', EDITOR: 'vim', LONG: 'a'.repeat(300), JWT: 'eyJabc', TALLY_HOME: '/t' });
    expect(Object.keys(env).sort()).toEqual(['EDITOR', 'HOME', 'PATH', 'TALLY_INTERNAL', 'TALLY_TEST_RERUN']);
    const denied = await runVerification(cwd, { timeoutMs: 1000, consent: false });
    expect(denied.ran).toBe(false);
    expect(denied.reason).toBe(NO_CONSENT_REASON);
  });

  it('the Coach asks once per repo; apply grants, skip declines, then it never fires again', () => {
    const { cwd } = repo();
    const cfg = loadConfig();
    const events = readEventsFile(path.join(basicFixture, 'events.jsonl')).map((e) => ({ ...e, cwd }));
    const ctx = buildContext({ session: 's', cwd, cfg, events, history: [] });
    const s = verificationConsent.evaluate(ctx);
    expect(s.length).toBe(1);
    expect(s[0]!.action.kind).toBe('consent');
    const r = applySuggestion(s[0]!, { session: 's', cwd, cfg, mode: 'ask' });
    expect(r.ok).toBe(true);
    expect(testRerunConsent(loadConfig(), cwd)).toBe(true);
    expect(verificationConsent.evaluate({ ...ctx, cfg: loadConfig() }).length).toBe(0);
    expect(applySuggestion(s[0]!, { session: 's', cwd, cfg, mode: 'auto' }).ok).toBe(false);
    const other = repo().cwd;
    const ctx2 = buildContext({ session: 's2', cwd: other, cfg: loadConfig(), events: events.map((e) => ({ ...e, cwd: other })), history: [] });
    const s2 = verificationConsent.evaluate(ctx2);
    expect(s2.length).toBe(1);
    skipSuggestion(s2[0]!, { session: 's2', cwd: other });
    expect(testRerunConsent(loadConfig(), other)).toBe(false);
    expect(verificationConsent.evaluate({ ...ctx2, cfg: loadConfig() }).length).toBe(0);
  });

  it('write-back comments and stored evidence pass through the redactor', async () => {
    const { cwd, base } = repo();
    setTestRerunConsent(cwd, true);
    const cfg = loadConfig();
    const llm = llmFor('h2d');
    const deps: FetchDeps = { ...noFetch, exec: (bin, args) => ({ ok: bin === 'gh' && args[1] === 'view', stdout: JSON.stringify({ title: 'Ship it', body: 'b', labels: [] }), stderr: '' }) };
    await intake({ session: 'h2d', cwd, ref: 'https://github.com/acme/app/issues/42', cfg, llm, deps });
    const events = readEventsFile(path.join(basicFixture, 'events.jsonl')).map((e) => (e.type === 'session_start' ? { ...e, cwd, data: { ...e.data, git_head: base } } : { ...e, cwd }));
    const j = await judgeSession({ session: 'h2d', cwd, transcriptPath: path.join(basicFixture, 'transcript.jsonl'), cfg, llm, reason: 'pr', events });
    const judgeCall = llm.calls.find((c) => c.kind === 'judge')!;
    expect(judgeCall.prompt).not.toContain(SECRET_DIFF);
    expect(JSON.stringify(j)).not.toContain(SECRET_DIFF);
    expect(JSON.stringify(j)).not.toContain(SECRET_MSG);
    expect(j.verification.env_scrubbed).toBe(true);
    const comment = receiptComment(j);
    expect(comment).not.toContain(SECRET_DIFF);
    expect(comment).not.toContain(SECRET_MSG);
    const stored = fs.readFileSync(path.join(iso.home, 'sessions', 'h2d', 'report.md'), 'utf8');
    expect(stored).not.toContain(SECRET_DIFF);
    expect(stored).not.toContain(SECRET_MSG);
    const bodies: string[] = [];
    await writeBack(j, cfg, { ...deps, exec: (_b, args) => { bodies.push(args[args.length - 1]!); return { ok: true, stdout: '', stderr: '' }; } });
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) {
      expect(b).not.toContain(SECRET_DIFF);
      expect(b).not.toContain(SECRET_MSG);
    }
  });
});
