import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isolate, basicFixture, tmpDir } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { StubLlm } from '../src/llm/client.js';
import { intake } from '../src/task/intake.js';
import { judgeSession, loadJudge } from '../src/judge/judge.js';
import { followupSession, adjustVerdict, detectRevert, dueSessions, runDueFollowups } from '../src/followup/followup.js';
import { readEventsFile } from '../src/store/events.js';
import { startExperiment, stopExperiment, recordAssignment, restoreExperimentConfig, prepareNextArm, loadExperiments, activeExperiment } from '../src/experiment/experiment.js';
import { buildReport, renderExperimentReport } from '../src/experiment/report.js';
import type { Exec } from '../src/judge/evidence.js';
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

function repoWithRevert(): { cwd: string; base: string } {
  const cwd = tmpDir('tally-fu-');
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.email', 't@t');
  git(cwd, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node -e 0' } }));
  fs.writeFileSync(path.join(cwd, 'a.js'), '1');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', 'base');
  const base = git(cwd, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(cwd, 'a.js'), '2');
  git(cwd, 'commit', '-q', '-am', 'add rate limiting to login (#57)');
  return { cwd, base };
}

const noFetch: FetchDeps = { exec: () => ({ ok: false, stdout: '', stderr: '' }), fetch: async () => ({ ok: false, status: 0, text: async () => '' }), readFile: () => '', exists: () => false };
const stub = (session: string) =>
  new StubLlm(
    {
      intake: () => ({ title: 'Rate limit login', criteria: [{ text: 'a', source: 'explicit' }, { text: 'b', source: 'explicit' }], spec_quality: { score: 7, missing: [], questions: [] }, estimate_hours: 3, rationale: '' }),
      judge: () => ({ criteria: [{ id: 'c1', status: 'met', evidence: 'x', files: [] }, { id: 'c2', status: 'met', evidence: 'y', files: [] }], quality_score: 8, quality_reason: 'r', verdict_reason: 'v', recommendations: ['a', 'b', 'c'] }),
    },
    session,
  );

async function judged(session: string, cwd: string, base: string) {
  const cfg = loadConfig();
  const llm = stub(session);
  await intake({ session, cwd, text: 'Rate limit login', cfg, llm, deps: noFetch });
  const events = readEventsFile(path.join(basicFixture, 'events.jsonl')).map((e) => (e.type === 'session_start' ? { ...e, cwd, session, data: { ...e.data, git_head: base } } : { ...e, cwd, session }));
  return judgeSession({ session, cwd, transcriptPath: path.join(basicFixture, 'transcript.jsonl'), cfg, llm, reason: 'pr', events, verification: { ran: true, command: 'npm test', passed: true } });
}

function ghExec(pr: Record<string, unknown>, runs: Array<Record<string, unknown>> = [], issueEvents: Array<Record<string, unknown>> = []): Exec {
  return (bin, args, cwd) => {
    if (bin === 'git') {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
      return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    }
    if (args[0] === 'pr') return { ok: true, stdout: JSON.stringify(pr), stderr: '' };
    if (args[0] === 'run') return { ok: true, stdout: JSON.stringify(runs), stderr: '' };
    if (args[0] === 'api') return { ok: true, stdout: JSON.stringify(issueEvents), stderr: '' };
    if (args[0] === 'issue') return { ok: true, stdout: JSON.stringify({ state: 'CLOSED' }), stderr: '' };
    return { ok: false, stdout: '', stderr: 'unknown' };
  };
}

describe('follow-up', () => {
  it('flips the verdict to not worth it when the PR was reverted', async () => {
    const { cwd, base } = repoWithRevert();
    const j = await judged('fu1', cwd, base);
    expect(j.verdict.verdict).toBe('worth it');
    const mergeSha = git(cwd, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(cwd, 'a.js'), '1');
    git(cwd, 'commit', '-q', '-am', `Revert "add rate limiting to login (#57)"\n\nThis reverts commit ${mergeSha}.`);
    const after = followupSession('fu1', { exec: ghExec({ state: 'MERGED', mergedAt: '2026-09-11T00:00:00Z', mergeCommit: { oid: mergeSha }, reviews: [], comments: [], number: 57, headRefName: 'feature/rate-limit' }), now: () => new Date('2026-09-20T00:00:00Z') });
    expect(after!.followup!.final_status).toBe('reverted');
    expect(after!.followup!.original_verdict).toBe('worth it');
    expect(after!.followup!.final_verdict).toBe('not worth it');
    expect(after!.followup!.revert_commit).toBeTruthy();
    expect(loadJudge('fu1')!.followup!.final_status).toBe('reverted');
    const report = fs.readFileSync(path.join(iso.home, 'sessions', 'fu1', 'report.md'), 'utf8');
    expect(report).toContain('after follow-up: **NOT WORTH IT**');
    expect(report).toContain('Reverted in');
    const hist = fs.readFileSync(path.join(iso.home, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { final_status?: string });
    expect(hist.at(-1)!.final_status).toBe('reverted');
  });

  it('marks held up when merged clean, and needed rework on change requests, reopen, or red CI', async () => {
    const { cwd, base } = repoWithRevert();
    await judged('fu2', cwd, base);
    const clean = followupSession('fu2', { exec: ghExec({ state: 'MERGED', mergedAt: 'x', mergeCommit: { oid: 'abc' }, reviews: [{ state: 'APPROVED' }], comments: [{}] }, [{ conclusion: 'success', name: 'ci' }]) });
    expect(clean!.followup!.final_status).toBe('held up');
    expect(clean!.followup!.final_verdict).toBe('worth it');
    expect(clean!.followup!.review_comments).toBe(2);
    await judged('fu3', cwd, base);
    const cr = followupSession('fu3', { exec: ghExec({ state: 'MERGED', mergeCommit: { oid: 'abc' }, reviews: [{ state: 'CHANGES_REQUESTED' }, { state: 'APPROVED' }], comments: [] }) });
    expect(cr!.followup!.final_status).toBe('needed rework');
    expect(cr!.followup!.change_requests).toBe(1);
    expect(cr!.followup!.final_verdict).toBe('borderline');
    await judged('fu4', cwd, base);
    const ci = followupSession('fu4', { exec: ghExec({ state: 'MERGED', mergeCommit: { oid: 'abc' }, reviews: [], comments: [] }, [{ conclusion: 'failure', name: 'test' }]) });
    expect(ci!.followup!.ci_failed_after_merge).toBe(true);
    expect(ci!.followup!.final_status).toBe('needed rework');
    await judged('fu5', cwd, base);
    const open = followupSession('fu5', { exec: ghExec({ state: 'OPEN', reviews: [], comments: [] }) });
    expect(open!.followup!.final_status).toBe('unknown');
  });

  it('adjusts verdicts and detects reverts by PR number, sha, or branch', () => {
    expect(adjustVerdict('worth it', 'needed rework')).toBe('borderline');
    expect(adjustVerdict('borderline', 'needed rework')).toBe('not worth it');
    expect(adjustVerdict('borderline', 'held up')).toBe('borderline');
    expect(adjustVerdict('worth it', 'reverted')).toBe('not worth it');
    const { cwd } = repoWithRevert();
    const exec: Exec = (bin, args, c) => {
      const r = spawnSync(bin, args, { cwd: c, encoding: 'utf8' });
      return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    };
    expect(detectRevert(cwd, exec, { prNumber: 57 }).reverted).toBe(false);
    git(cwd, 'commit', '-q', '--allow-empty', '-m', 'Revert "feature/rate-limit changes"');
    expect(detectRevert(cwd, exec, { branch: 'feature/rate-limit' }).reverted).toBe(true);
    expect(detectRevert(cwd, exec, { prNumber: 99 }).reverted).toBe(false);
  });

  it('schedules follow-ups after 7 days and records the run', async () => {
    const { cwd, base } = repoWithRevert();
    await judged('fu6', cwd, base);
    const j = loadJudge('fu6')!;
    const now = new Date(Date.parse(j.judged_at) + 8 * 86400000);
    expect(dueSessions(7, now)).toEqual(['fu6']);
    expect(dueSessions(7, new Date(Date.parse(j.judged_at) + 2 * 86400000))).toEqual([]);
    const done = runDueFollowups(7, { exec: ghExec({ state: 'MERGED', mergeCommit: { oid: 'abc' }, reviews: [], comments: [] }), now: () => now });
    expect(done.length).toBe(1);
    expect(fs.existsSync(path.join(iso.home, 'followup-state.json'))).toBe(true);
    expect(dueSessions(7, now)).toEqual([]);
  });
});

describe('experiments', () => {
  it('alternates arms, patches settings.local.json, and restores it byte-identically', () => {
    const cwd = tmpDir('tally-exp-');
    const file = path.join(cwd, '.claude', 'settings.local.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const original = '{\n  "model": "opus"\n}\n';
    fs.writeFileSync(file, original);
    const exp = startExperiment(cwd, 'mcp', 'jira', 4);
    expect(exp.next_arm).toBe('off');
    const patched = JSON.parse(fs.readFileSync(file, 'utf8')) as { disabledMcpjsonServers: string[]; model: string };
    expect(patched.disabledMcpjsonServers).toEqual(['jira']);
    expect(patched.model).toBe('opus');
    expect(recordAssignment(cwd, 'sess-a')).toBe('off');
    expect(recordAssignment(cwd, 'sess-a')).toBe('off');
    expect(loadExperiments().experiments[0]!.assignments.length).toBe(1);
    expect(restoreExperimentConfig(cwd, 'sess-a')).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    prepareNextArm(cwd);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).disabledMcpjsonServers).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))._tally_experiment.arm).toBe('on');
    expect(recordAssignment(cwd, 'sess-b')).toBe('on');
    restoreExperimentConfig(cwd, 'sess-b');
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    prepareNextArm(cwd);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).disabledMcpjsonServers).toEqual(['jira']);
    stopExperiment(cwd);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(activeExperiment(cwd)).toBeUndefined();
  });

  it('handles a skill arm and a missing settings file (restored to missing)', () => {
    const cwd = tmpDir('tally-exp2-');
    const file = path.join(cwd, '.claude', 'settings.local.json');
    startExperiment(cwd, 'skill', 'superpowers:brainstorming', 2);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).permissions.deny).toEqual(['Skill(superpowers:brainstorming)']);
    recordAssignment(cwd, 's1');
    restoreExperimentConfig(cwd, 's1');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('reports honestly about sample size and compares arms', async () => {
    const cwd = tmpDir('tally-exp3-');
    const exp = startExperiment(cwd, 'skill', 'tdd', 8);
    let r = buildReport(exp);
    expect(r.enough_data).toBe(false);
    expect(r.verdict).toContain('not enough data');
    expect(renderExperimentReport(r)).toContain('not enough data');
    const { cwd: repo, base } = repoWithRevert();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const id = `ex${i}`;
      ids.push(id);
      recordAssignment(cwd, id);
      restoreExperimentConfig(cwd, id);
      prepareNextArm(cwd);
      await judged(id, repo, base);
    }
    const db = loadExperiments();
    const e = db.experiments.find((x) => x.id === exp.id)!;
    expect(e.assignments.map((a) => a.arm)).toEqual(['off', 'on', 'off', 'on', 'off', 'on']);
    r = buildReport(e);
    expect(r.enough_data).toBe(true);
    expect(r.arms.on.judged).toBe(3);
    expect(r.arms.off.judged).toBe(3);
    expect(r.arms.on.completion_pct).toBe(100);
    expect(r.verdict).toContain('no clear difference');
    expect(renderExperimentReport(r)).toContain('cost/criterion');
  });
});
