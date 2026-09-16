import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isolate, basicFixture, tmpDir, root } from './helpers.js';
import { startPlan } from '../src/commands/start.js';
import { followupSession } from '../src/followup/followup.js';
import { ghStatus, resetGhStatusCache } from '../src/followup/gh.js';
import { loadConfig } from '../src/config.js';
import { StubLlm } from '../src/llm/client.js';
import { intake } from '../src/task/intake.js';
import { judgeSession } from '../src/judge/judge.js';
import { readEventsFile } from '../src/store/events.js';
import { encodeProjectDir, packageRoot, builtHookPath } from '../src/paths.js';
import { runVerification } from '../src/judge/verify.js';
import type { FetchDeps } from '../src/task/fetchers.js';

let iso: ReturnType<typeof isolate>;
beforeEach(() => {
  iso = isolate();
});
afterEach(() => iso.restore());

describe('H4 cross-platform', () => {
  it('start picks a strategy per OS and always falls back to printing the command', () => {
    const none = () => false;
    const all = () => true;
    const print = startPlan({}, 'linux', false, none);
    expect(print.kind).toBe('print');
    expect(print.message).toContain('tally watch');
    expect(startPlan({}, 'linux', false, all).kind).toBe('tmux-new');
    expect(startPlan({ TMUX: '/tmp/tmux-1000/default,1,0' }, 'linux', false, all).kind).toBe('tmux-split');
    const win = startPlan({}, 'win32', false, none);
    expect(win.kind).toBe('print');
    expect(win.message).toContain('Windows Terminal');
    expect(startPlan({ WT_SESSION: 'abc' }, 'win32', false, all).kind).toBe('wt-split');
    expect(startPlan({}, 'win32', false, all).kind).toBe('print');
    const plain = startPlan({}, 'darwin', true, none);
    expect(plain.cmd).toBe('tally watch --plain');
    const r = spawnSync(process.execPath, [path.join(root, 'dist', 'cli.js'), 'start'], { encoding: 'utf8', env: { ...process.env, TMUX: '', WT_SESSION: '', PATH: path.dirname(process.execPath) } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('tally watch');
  });

  it('project dir encoding and package-root resolution work with both path styles', () => {
    expect(encodeProjectDir('C:\\Users\\dev\\acme-app')).toBe('C--Users-dev-acme-app');
    expect(encodeProjectDir('/home/dev/acme.app')).toBe('-home-dev-acme-app');
    expect(fs.existsSync(path.join(packageRoot(), 'package.json'))).toBe(true);
    expect(builtHookPath().endsWith(path.join('dist', 'hook.js'))).toBe(true);
  });

  it('verification uses the platform shell and kills the process tree on timeout', async () => {
    const cwd = tmpDir('tally-h4-');
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "setTimeout(()=>{},30000)"' } }));
    const t0 = Date.now();
    const r = await runVerification(cwd, { timeoutMs: 700, consent: true });
    expect(r.timed_out).toBe(true);
    expect(Date.now() - t0).toBeLessThan(10000);
  });

  it('gh status explains the fix when gh is missing, and follow-up says it was skipped instead of failing', async () => {
    const prevPath = process.env.PATH;
    process.env.PATH = path.dirname(process.execPath);
    resetGhStatusCache();
    const s = ghStatus(true);
    process.env.PATH = prevPath;
    resetGhStatusCache();
    expect(s.ok).toBe(false);
    expect(s.fix.length).toBeGreaterThan(5);
    expect(s.reason).toContain('gh');

    const repo = tmpDir('tally-h4-repo-');
    const git = (...a: string[]) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    fs.writeFileSync(path.join(repo, 'a.js'), '1');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    const base = git('rev-parse', 'HEAD').stdout.trim();
    const llm = new StubLlm({ intake: () => ({ title: 't', criteria: [{ text: 'a', source: 'explicit' }], spec_quality: { score: 7, missing: [], questions: [] }, estimate_hours: 1, rationale: '' }), judge: () => ({ criteria: [{ id: 'c1', status: 'met', evidence: 'e', files: [] }], quality_score: 7, quality_reason: 'r', verdict_reason: 'v', recommendations: ['a', 'b', 'c'] }) }, 'h4');
    const deps: FetchDeps = { exec: (b, a) => ({ ok: b === 'gh' && a[1] === 'view', stdout: JSON.stringify({ title: 't', body: 'b', labels: [] }), stderr: '' }), fetch: async () => ({ ok: false, status: 0, text: async () => '' }), readFile: () => '', exists: () => false };
    await intake({ session: 'h4', cwd: repo, ref: 'https://github.com/acme/app/issues/42', cfg: loadConfig(), llm, deps });
    const events = readEventsFile(path.join(basicFixture, 'events.jsonl')).map((e) => (e.type === 'session_start' ? { ...e, cwd: repo, data: { ...e.data, git_head: base } } : { ...e, cwd: repo }));
    await judgeSession({ session: 'h4', cwd: repo, transcriptPath: path.join(basicFixture, 'transcript.jsonl'), cfg: loadConfig(), llm, reason: 'pr', events, verification: { ran: false, reason: 'skip' } });
    const withoutGh = { PATH: path.dirname(process.execPath) };
    const prev = process.env.PATH;
    process.env.PATH = withoutGh.PATH;
    resetGhStatusCache();
    let j;
    try {
      j = followupSession('h4');
    } finally {
      process.env.PATH = prev;
      resetGhStatusCache();
    }
    expect(j!.followup!.gh_skipped).toBe(true);
    expect(j!.followup!.final_status).toBe('unknown');
    expect(j!.followup!.notes.some((n) => n.startsWith('Follow-up skipped: gh'))).toBe(true);
  });
});
