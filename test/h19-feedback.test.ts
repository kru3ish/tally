import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isolate, root, basicFixture, tmpDir } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { StubLlm } from '../src/llm/client.js';
import { intake } from '../src/task/intake.js';
import { judgeSession } from '../src/judge/judge.js';
import { readEventsFile } from '../src/store/events.js';
import type { FetchDeps } from '../src/task/fetchers.js';
import { recordFeedback, readFeedback, countVerification, readUsefulness, shouldAskUsefulness, recordUsefulness, parseUsefulnessAnswer, USEFULNESS_AFTER } from '../src/feedback/store.js';
import { buildWrongVerdictReport, scanForSecrets, issueUrl } from '../src/feedback/report.js';
import { askUsefulness } from '../src/feedback/prompt.js';

const CLI = path.join(root, 'dist', 'cli.js');
let iso: ReturnType<typeof isolate>;
beforeEach(() => {
  iso = isolate();
});
afterEach(() => iso.restore());

const deps = { exec: () => ({ ok: false, stdout: '', stderr: '' }), fetch: async () => ({ ok: false, status: 0, text: async () => '' }), readFile: () => '', exists: () => false } as FetchDeps;

function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_EMAIL: 't@t', GIT_AUTHOR_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_COMMITTER_NAME: 't' } });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

/* a judged session with one VERIFIED (tier 0), one SUPPORTED (model) and one UNMET criterion */
async function judged(session: string): Promise<{ cwd: string }> {
  const cwd = tmpDir('tally-fb-');
  git(cwd, ['init', '-q', '-b', 'main']);
  fs.mkdirSync(path.join(cwd, 'src'));
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'app', scripts: { test: 'node -e "console.log(\'1 passing\')"' } }));
  fs.writeFileSync(path.join(cwd, 'src', 'login.js'), 'module.exports = () => 200;\n');
  fs.writeFileSync(path.join(cwd, 'README.md'), '# app\n');
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '-m', 'base']);
  const base = git(cwd, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(cwd, 'src', 'login.js'), 'module.exports = (n) => (n > 5 ? 429 : 200);\n');
  git(cwd, ['commit', '-q', '-am', 'work']);
  const stub = {
    intake: () => ({ title: 'Rate limit login', criteria: [{ text: 'Login returns 429 after 5 failed attempts', source: 'explicit' }, { text: 'The test suite passes', source: 'explicit', check: { kind: 'tests_pass' } }, { text: 'README documents the limit', source: 'explicit', check: { kind: 'file_changed', path: 'README.md' } }], spec_quality: { score: 8, missing: [], questions: [] }, estimate_hours: 1, rationale: 'x', constraints: [] }),
    judge: () => ({ criteria: [{ id: 'c1', status: 'met', evidence: 'src/login.js maps attempts above 5 to 429', files: ['src/login.js'], confidence: 0.9 }], quality_score: 7, quality_reason: 'r', verdict_reason: 'v', recommendations: ['a', 'b', 'c'] }),
    review: () => ({ layer: 'at_root_cause', layer_note: '', blast_radius: 'contained', blast_note: '', untested_surface: [], merge: 'merge', note: '' }),
  };
  const llm = new StubLlm(stub, session);
  const cfg = loadConfig();
  cfg.judge.maintainer_review = 'off';
  await intake({ session, cwd, text: 'Rate limit the login endpoint', cfg, llm, deps });
  const events = readEventsFile(path.join(basicFixture, 'events.jsonl')).map((e) => (e.type === 'session_start' ? { ...e, cwd, data: { ...e.data, git_head: base } } : { ...e, cwd }));
  await judgeSession({ session, cwd, transcriptPath: path.join(basicFixture, 'transcript.jsonl'), cfg, llm, reason: 'push', events, consent: true });
  return { cwd };
}

describe('feedback: local labels next to the receipt', () => {
  it('records a label with what Tally had said, flags a wrong VERIFIED, and rejects unknown criteria', async () => {
    await judged('fb-1');
    const { entry } = recordFeedback('fb-1', 'c2', 'wrong', 'the runner printed 1 passing but ran nothing', '9.9.9');
    expect(entry.assurance).toBe('VERIFIED');
    expect(entry.judge_status).toBe('met');
    expect(entry.resolved_by).toBe('tier0');
    expect(entry.false_verified).toBe(true);
    expect(entry.tally_version).toBe('9.9.9');
    const c1 = recordFeedback('fb-1', 'c1', 'correct', undefined).entry;
    expect(c1.assurance).toBe('SUPPORTED');
    expect(c1.false_verified).toBe(false);
    expect(readFeedback('fb-1').map((f) => `${f.criterion}:${f.label}`)).toEqual(['c2:wrong', 'c1:correct']);
    expect(fs.existsSync(path.join(iso.home, 'sessions', 'fb-1', 'feedback.jsonl'))).toBe(true);
    expect(() => recordFeedback('fb-1', 'c9', 'unsure', undefined)).toThrow(/no criterion c9/);
    expect(() => recordFeedback('nope', 'c1', 'unsure', undefined)).toThrow(/no receipt/);
  });

  it('the wrong-verdict report carries shape and counts only, never text, paths or names', async () => {
    const { cwd } = await judged('fb-2');
    recordFeedback('fb-2', 'c2', 'wrong', 'see the tally-eval run', '9.9.9');
    const r = buildWrongVerdictReport('fb-2', 'c2', { version: '9.9.9', cwd });
    expect(r.schema).toBe('tally.wrong-verdict.v1');
    expect(r.criterion).toMatchObject({ id: 'c2', index: 2, of: 3, judge_status: 'met', assurance: 'VERIFIED', resolved_by: 'tier0' });
    expect(r.feedback.false_verified).toBe(true);
    expect(r.feedback.comment_included).toBe(false);
    expect(r.verification.ran).toBe(true);
    expect(r.verification.runner).toBe('npm');
    expect(r.receipt.assurance.VERIFIED).toBe(1);
    expect(r.receipt.assurance.UNMET).toBe(1);
    const payload = JSON.stringify(r);
    for (const leak of ['login', 'README', 'Rate limit', cwd, 'src/', '429 after', 'tally-fb-']) expect(payload, `payload leaks ${leak}`).not.toContain(leak);
    expect(r.criterion.evidence.every((e) => Object.keys(e).every((k) => ['kind', 'strength', 'ok'].includes(k)))).toBe(true);
    expect(scanForSecrets(payload)).toEqual([]);
    /* the comment is opt-in and the only free text */
    const withComment = buildWrongVerdictReport('fb-2', 'c2', { version: '9.9.9', cwd, includeComment: true });
    expect(withComment.feedback.comment).toBe('see the tally-eval run');
    const url = issueUrl(r);
    expect(url).toMatch(/^https:\/\/github\.com\/kru3ish\/tally\/issues\/new\?template=wrong_verdict\.md/);
    expect(url).toContain(encodeURIComponent('[false VERIFIED]'));
    expect(url).toContain(encodeURIComponent('false-verified'));
  });

  it('the secret scan names what it found and blocks', () => {
    expect(scanForSecrets('{"comment":"token=sk-ant-abcdefghijklmnop123"}')).toContain('Anthropic API key');
    expect(scanForSecrets('{"comment":"mail me at dev@example.com"}')).toContain('email address');
    expect(scanForSecrets('{"comment":"see https://ci.corp.example/build/1"}')).toContain('URL');
    expect(scanForSecrets('{"comment":"it was in C:\\\\Users\\\\me\\\\repo"}')).toContain('absolute file path');
    expect(scanForSecrets('{"comment":"-----BEGIN RSA PRIVATE KEY-----"}')).toContain('private key block');
    expect(scanForSecrets('{"comment":"the test asserted 50 where the task said 5"}')).toEqual([]);
  });

  it('the CLI records, lists, and writes a report file; a secret in the comment blocks --report', async () => {
    const { cwd } = await judged('fb-3');
    const env = { ...process.env, TALLY_HOME: iso.home, CLAUDE_CONFIG_DIR: iso.claude };
    const list = spawnSync(process.execPath, [CLI, 'feedback', '--session', 'fb-3'], { cwd, encoding: 'utf8', env });
    expect(list.status).toBe(0);
    expect(list.stdout).toMatch(/c1\s+SUPPORTED/);
    expect(list.stdout).toMatch(/c2\s+VERIFIED/);
    const out = path.join(cwd, 'bug.json');
    const rep = spawnSync(process.execPath, [CLI, 'feedback', 'wrong', 'c2', '--session', 'fb-3', '--comment', 'runner ran nothing', '--report', '--out', out], { cwd, encoding: 'utf8', env });
    expect(rep.status, rep.stderr).toBe(0);
    expect(rep.stdout).toMatch(/Recorded: c2 VERIFIED/);
    expect(rep.stdout).toMatch(/release-blocking/);
    expect(rep.stdout).toMatch(/Wrote .*bug\.json/);
    const j = JSON.parse(fs.readFileSync(out, 'utf8')) as { schema: string; feedback: { false_verified: boolean } };
    expect(j.schema).toBe('tally.wrong-verdict.v1');
    expect(j.feedback.false_verified).toBe(true);
    const blocked = spawnSync(process.execPath, [CLI, 'feedback', 'wrong', 'c1', '--session', 'fb-3', '--comment', 'key ghp_abcdefghijklmnopqrstuvwxyz1234', '--report', '--include-comment', '--out', path.join(cwd, 'blocked.json')], { cwd, encoding: 'utf8', env });
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toMatch(/Report blocked: .*GitHub token/);
    expect(fs.existsSync(path.join(cwd, 'blocked.json'))).toBe(false);
    /* the plugin's one-string form */
    const plug = spawnSync(process.execPath, [CLI, 'feedback', '--from-args', 'c3 correct docs landed', '--session', 'fb-3'], { cwd, encoding: 'utf8', env });
    expect(plug.status).toBe(0);
    expect(plug.stdout).toMatch(/Recorded: c3 UNMET .* → correct · "docs landed"/);
  });
});

describe('the one-time usefulness question', () => {
  it('asks after the fifth real verification, only interactively, and never again after any answer', async () => {
    for (let i = 0; i < USEFULNESS_AFTER - 1; i++) countVerification('real-' + i);
    expect(shouldAskUsefulness(readUsefulness(), { interactive: true })).toBe(false);
    /* demo and internal runs do not count */
    countVerification('demo-abc');
    process.env.TALLY_INTERNAL = '1';
    countVerification('real-x');
    delete process.env.TALLY_INTERNAL;
    expect(readUsefulness().verifications).toBe(USEFULNESS_AFTER - 1);
    countVerification('real-5');
    const s = readUsefulness();
    expect(shouldAskUsefulness(s, { interactive: false })).toBe(false);
    expect(shouldAskUsefulness(s, { interactive: true, ci: true })).toBe(false);
    const prevCI = process.env.CI;
    process.env.CI = '1';
    expect(shouldAskUsefulness(s, { interactive: true })).toBe(false);
    if (prevCI === undefined) delete process.env.CI;
    else process.env.CI = prevCI;
    expect(shouldAskUsefulness(s, { interactive: true })).toBe(true);
    let text = '';
    const answer = await askUsefulness({ question: async () => 'skip', out: (x) => (text += x) });
    expect(answer).toBe('skip');
    expect(text).toMatch(/asked once/);
    expect(readUsefulness().asked).toBeTruthy();
    expect(readUsefulness().answer).toBe('skip');
    countVerification('real-6');
    expect(shouldAskUsefulness(readUsefulness(), { interactive: true })).toBe(false);
    expect(parseUsefulnessAnswer('Y')).toBe('yes');
    expect(parseUsefulnessAnswer('no')).toBe('no');
    expect(parseUsefulnessAnswer('')).toBe('skip');
    recordUsefulness('yes');
    expect(readUsefulness().answer).toBe('yes');
  });
});
