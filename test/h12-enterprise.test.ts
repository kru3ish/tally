import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isolate, basicFixture, tmpDir, root } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { StubLlm } from '../src/llm/client.js';
import { intake, loadTask } from '../src/task/intake.js';
import { judgeSession, computeVerdict, loadJudge, rescoreJudge } from '../src/judge/judge.js';
import { disputeCriterion, parseDisputeArgs, resolveSessionPrefix } from '../src/commands/dispute.js';
import { approveBudget, hardStopFile, readHardStop } from '../src/commands/budget.js';
import { run as coachRun } from '../src/commands/coach.js';
import { receiptComment } from '../src/judge/writeback.js';
import { explainCriterion, explainAll } from '../src/judge/explain.js';
import { clusterLessons, playbookSnippet, lessonKey } from '../src/commands/playbook.js';
import { exportRow } from '../src/commands/export.js';
import { loadPolicy } from '../src/policy.js';
import { readCalibration, buildCalibrationReport } from '../src/calibrate/calibrate.js';
import { adjustVerdict } from '../src/followup/followup.js';
import { readEvents, appendEvent, readEventsFile } from '../src/store/events.js';
import { computeTrend, renderTrend } from '../src/report/report.js';
import { sessionDir } from '../src/paths.js';
import type { HistoryEntry } from '../src/coach/types.js';

const HOOK = path.join(root, 'dist', 'hook.js');

let iso: ReturnType<typeof isolate>;
beforeEach(() => {
  iso = isolate();
});
afterEach(() => iso.restore());

const intakeStub = (session: string, extra: Array<{ text: string; check?: unknown }> = []) =>
  new StubLlm(
    {
      intake: () => ({ title: 'Rate limit the login endpoint', criteria: [{ text: 'Login returns 429 above the limit', source: 'explicit', check: { kind: 'none' } }, { text: 'README documents the limit', source: 'explicit', check: { kind: 'file_changed', path: 'README.md' } }, ...extra.map((e) => ({ ...e, source: 'inferred' }))], spec_quality: { score: 7, missing: [], questions: [] }, estimate_hours: 2, rationale: '' }),
      judge: () => ({ criteria: [{ id: 'c1', status: 'met', evidence: 'rateLimit.ts returns 429 in the reconstructed write', files: ['src/middleware/rateLimit.ts'], confidence: 0.9 }], quality_score: 7, quality_reason: 'r', verdict_reason: 'v', recommendations: ['Run the full test suite once before pushing.', 'Read the ticket checklist before saying done.', 'Stop calling the Jira MCP after the first 401.'] }),
    },
    session,
  );

async function reconstructedJudge(session: string, cwd: string) {
  const cfg = loadConfig();
  const llm = intakeStub(session);
  await intake({ session, cwd, text: 'rate limit the login endpoint', cfg, llm });
  for (const e of readEventsFile(path.join(basicFixture, 'events.jsonl'))) appendEvent({ ...e, session, cwd });
  appendEvent({ ts: new Date().toISOString(), type: 'session_start', session, cwd, data: { transcript_path: path.join(basicFixture, 'transcript.jsonl') } });
  return judgeSession({ session, cwd, transcriptPath: path.join(basicFixture, 'transcript.jsonl'), cfg, llm, reason: 'manual', skipGit: true, verification: { ran: false, reason: 'no tree' } });
}

describe('abstention', () => {
  it('the Judge says "insufficient evidence" instead of guessing when it could not check enough', () => {
    expect(computeVerdict({ completion_pct: 0, roi: null, quality: 7, testsFailed: false, verifiable: 0, unverifiable: 3 })).toBe('insufficient evidence');
    expect(computeVerdict({ completion_pct: 100, roi: 3, quality: 7, testsFailed: false, verifiable: 1, unverifiable: 6 })).toBe('insufficient evidence');
    expect(computeVerdict({ completion_pct: 100, roi: 3, quality: 7, testsFailed: false, verifiable: 3, unverifiable: 1 })).toBe('worth it');
    expect(adjustVerdict('insufficient evidence', 'held up')).toBe('borderline');
    expect(adjustVerdict('insufficient evidence', 'reverted')).toBe('not worth it');
    expect(adjustVerdict('insufficient evidence', 'needed rework')).toBe('insufficient evidence');
    const h: HistoryEntry[] = [
      { ts: '2026-09-01T01:00:00Z', session: 'a', repo: 'r', verdict: 'insufficient evidence', completion_pct: 0, cost_usd: 2, linked: false },
      { ts: '2026-09-02T01:00:00Z', session: 'b', repo: 'r', verdict: 'worth it', completion_pct: 100, cost_usd: 1, linked: true },
    ];
    const t = computeTrend({ history: h });
    expect(t.abstained).toBe(1);
    expect(renderTrend(t)).toContain('abstained            1 of 2');
  });
});

describe('repo policy', () => {
  it('standing criteria are appended to every task and the budget block is honoured', async () => {
    const cwd = tmpDir('tally-policy-');
    fs.writeFileSync(path.join(cwd, 'tally.json'), JSON.stringify({ criteria: [{ text: 'New code has tests', check: { kind: 'tests_pass' } }, { text: 'No secrets committed' }], budget: { hourly_rate: 120, fraction: 0.5, hard_stop: true } }, null, 2));
    expect(loadPolicy(cwd).policy.criteria.length).toBe(2);
    fs.mkdirSync(path.join(cwd, 'src', 'deep'), { recursive: true });
    expect(loadPolicy(path.join(cwd, 'src', 'deep')).file).toContain('tally.json');
    const session = 'policy-session-0001';
    const r = await intake({ session, cwd, text: 'rate limit the login endpoint', cfg: loadConfig(), llm: intakeStub(session) });
    const policy = r.task.criteria.filter((c) => c.source === 'policy');
    expect(policy.map((c) => c.text)).toEqual(['New code has tests', 'No secrets committed']);
    expect(policy[0]!.kind).toBe('mechanical');
    expect(policy[1]!.kind).toBe('judgment');
    expect(r.task.hourly_rate).toBe(120);
    expect(r.task.budget_usd).toBe(120);
    fs.writeFileSync(path.join(cwd, 'tally.json'), JSON.stringify({ budget: { usd: 9 } }));
    const r2 = await intake({ session: 'policy-session-0002', cwd, text: 'rate limit the login endpoint', cfg: loadConfig(), llm: intakeStub('policy-session-0002') });
    expect(r2.task.budget_usd).toBe(9);
    fs.writeFileSync(path.join(cwd, 'tally.json'), '{ "budget": { "fraction": 5 } }');
    expect(loadPolicy(cwd).error).toContain('fraction');
  });

  it('a hard stop denies tool calls until a human approves', async () => {
    const cwd = tmpDir('tally-stop-');
    fs.writeFileSync(path.join(cwd, 'tally.json'), JSON.stringify({ budget: { usd: 1, hard_stop: true } }));
    const session = 'stop-session-0001';
    await intake({ session, cwd, text: 'rate limit the login endpoint', cfg: loadConfig(), llm: intakeStub(session) });
    for (const e of readEventsFile(path.join(basicFixture, 'events.jsonl'))) appendEvent({ ...e, session, cwd });
    /* the fixture transcript costs $1.33, over the $1 policy budget: the tick writes the stop marker */
    fs.copyFileSync(path.join(basicFixture, 'transcript.jsonl'), path.join(cwd, 'transcript.jsonl'));
    appendEvent({ ts: new Date().toISOString(), type: 'session_start', session, cwd, data: { transcript_path: path.join(cwd, 'transcript.jsonl') } });
    await coachRun({ _: [], flags: { tick: true, session, cwd, auto: true } });
    const stop = readHardStop(session)!;
    expect(stop).toBeTruthy();
    expect(stop.budget_usd).toBe(1);
    expect(stop.spend_usd).toBeGreaterThan(1);
    const deny = spawnSync(process.execPath, [HOOK, 'PreToolUse'], { input: JSON.stringify({ session_id: session, cwd, tool_name: 'Edit', tool_use_id: 't1', tool_input: { file_path: 'x' } }), encoding: 'utf8', env: { ...process.env, TALLY_NO_SPAWN: '1' } });
    expect(deny.status).toBe(0);
    const out = JSON.parse(deny.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('tally budget approve');
    expect(readEvents(session).some((e) => e.type === 'hard_stop_denied')).toBe(true);
    /* the approve command itself is never denied */
    const allow = spawnSync(process.execPath, [HOOK, 'PreToolUse'], { input: JSON.stringify({ session_id: session, cwd, tool_name: 'Bash', tool_use_id: 't2', tool_input: { command: 'tally budget approve --note "client asked"' } }), encoding: 'utf8', env: { ...process.env, TALLY_NO_SPAWN: '1' } });
    expect(allow.stdout.trim()).toBe('');
    expect(approveBudget(session, 'alice', 'client asked', cwd).lifted).toBe(true);
    expect(fs.existsSync(hardStopFile(session))).toBe(false);
    await coachRun({ _: [], flags: { tick: true, session, cwd, auto: true } });
    expect(fs.existsSync(hardStopFile(session))).toBe(false);
    expect(readEvents(session).some((e) => e.type === 'budget_approved')).toBe(true);
  });
});

describe('dispute and override', () => {
  it('keeps the original next to the override, re-scores the receipt, and logs a labelled calibration entry', async () => {
    const cwd = tmpDir('tally-dispute-');
    const session = 'dispute-session-0001';
    const j = await reconstructedJudge(session, cwd);
    const before = j.criteria.find((c) => c.id === 'c2')!;
    const r = disputeCriterion(session, 'c2', 'met', 'README was updated in the follow-up PR', 'alice');
    const c2 = r.judge.criteria.find((c) => c.id === 'c2')!;
    expect(c2.override).toMatchObject({ status: 'met', original: before.status, by: 'alice' });
    expect(c2.status).toBe(before.status);
    expect(r.judge.counts.met).toBe(j.counts.met + (before.status === 'met' ? 0 : 1));
    expect(r.judge.verdict.reason).toContain('re-scored: disputed c2');
    expect(loadJudge(session)!.criteria.find((c) => c.id === 'c2')!.override!.reason).toContain('follow-up PR');
    const entry = readCalibration().find((e) => e.source === 'dispute')!;
    expect(entry.criteria).toEqual([expect.objectContaining({ id: 'c2', human: 'met', judge: before.status })]);
    expect(entry.grader).toBe('alice');
    expect(buildCalibrationReport(readCalibration().filter((e) => e.source === 'dispute')).disagreements.length).toBe(1);
    expect(fs.readFileSync(path.join(sessionDir(session), 'report.md'), 'utf8')).toContain('disputed, was');
    expect(() => disputeCriterion(session, 'c9', 'met', 'x', 'bob')).toThrow(/no criterion c9/);
    expect(resolveSessionPrefix(session.slice(0, 8))).toBe(session);
    expect(() => resolveSessionPrefix('zzzz')).toThrow(/no session/);
    expect(parseDisputeArgs('c2 met README was updated later')).toEqual({ id: 'c2', status: 'met', reason: 'README was updated later' });
    expect(parseDisputeArgs('c2 maybe')).toBeNull();
    /* a second dispute on the same criterion keeps the very first original */
    const again = disputeCriterion(session, 'c2', 'partial', 'on reflection', 'bob');
    expect(again.judge.criteria.find((c) => c.id === 'c2')!.override!.original).toBe(before.status);
    expect(rescoreJudge(again.judge, 'noop').counts.partial).toBe(again.judge.counts.partial);
  });
});

describe('explain and reviewer brief', () => {
  it('--explain shows the evidence, the transcript moments and the dispute hint; the PR brief has the review sections', async () => {
    const cwd = tmpDir('tally-explain-');
    const session = 'explain-session-0001';
    const j = await reconstructedJudge(session, cwd);
    const text = explainCriterion(session, 'c1');
    expect(text).toMatch(/c1 · met · resolved by tier[12] at confidence 0\.90/);
    expect(text).toContain('Evidence cited');
    expect(text).toContain('rateLimit.ts returns 429');
    expect(text).toContain('reconstructed from the transcript');
    expect(text).toContain('Transcript moments touching those files');
    expect(text).toMatch(/Write rateLimit\.ts/);
    expect(text).toContain(`tally dispute ${session.slice(0, 8)} c1`);
    expect(explainCriterion(session, 'c9')).toContain('No criterion c9');
    expect(explainAll(session).split('─'.repeat(72)).length).toBe(j.criteria.length);
    const brief = receiptComment(j);
    expect(brief).toContain('**Rated by the model from the evidence**');
    expect(brief).toContain('**Needs a manual look**');
    expect(brief).toContain('**Where the agent struggled**');
    expect(brief).toContain('failed 3×');
    expect(brief).toContain('Not verified against disk');
    expect(brief).not.toMatch(/Implement https/);
  });
});

describe('playbook and export', () => {
  it('clusters recurring lessons into a CLAUDE.md snippet', () => {
    const h: HistoryEntry[] = [
      { ts: '2026-09-01T00:00:00Z', session: 'a', repo: 'r1', verdict: 'worth it', recommendations: ['Run the full test suite once before pushing instead of after each edit.', 'Read the ticket checklist before saying done.'] },
      { ts: '2026-09-02T00:00:00Z', session: 'b', repo: 'r1', verdict: 'borderline', recommendations: ['Run the full test suite once before pushing, not after every edit.', 'Stop calling the Jira MCP after the first 401.'] },
      { ts: '2026-09-03T00:00:00Z', session: 'c', repo: 'r2', verdict: 'worth it', recommendations: ['Run the full test suite once before pushing.'] },
    ];
    expect(lessonKey('Run the full test suite once before pushing instead of after each edit.')).toBe(lessonKey('Run the full test suite once before pushing, not after every edit.'));
    const all = clusterLessons(h);
    expect(all[0]!.count).toBe(3);
    expect(all[0]!.repos).toEqual(['r1', 'r2']);
    expect(clusterLessons(h, 'r1')[0]!.count).toBe(2);
    const snippet = playbookSnippet(all, 3);
    expect(snippet).toContain('## Lessons from Tally receipts');
    expect(snippet).toContain('(seen 3×)');
    expect(snippet).not.toContain('Jira MCP');
  });

  it('export carries numbers and statuses only, and titles only when asked', async () => {
    const cwd = tmpDir('tally-export-');
    const session = 'export-session-0001';
    const j = await reconstructedJudge(session, cwd);
    const h: HistoryEntry = { ts: '2026-09-01T00:00:00Z', session, repo: 'r', verdict: j.verdict.verdict, completion_pct: j.completion_pct, cost_usd: j.cost.total_usd, task_title: 'Rate limit the login endpoint', task_source: 'inferred', prompts: ['secret prompt'] };
    const row = exportRow(h, false);
    expect(row.schema).toBe('tally.receipt.v1');
    expect(row.task_title).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain('secret prompt');
    expect(JSON.stringify(row)).not.toContain('Login returns 429');
    expect(row.criteria!.map((c) => c.id)).toEqual(j.criteria.map((c) => c.id));
    expect(row.counts).toEqual(j.counts);
    expect(row.tiers).toEqual(j.tiers.ran);
    expect(exportRow(h, true).task_title).toBe('Rate limit the login endpoint');
  });
});

describe('policy test_command', () => {
  it('the Judge runs the configured command instead of the detected runner', async () => {
    const { runVerification } = await import('../src/judge/verify.js');
    const { loadPolicy } = await import('../src/policy.js');
    const cwd = tmpDir('tally-testcmd-');
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(1)"' } }));
    fs.writeFileSync(path.join(cwd, 'tally.json'), JSON.stringify({ test_command: 'node -e "process.exit(0)"' }));
    const pol = loadPolicy(cwd);
    expect(pol.policy.test_command).toBe('node -e "process.exit(0)"');
    const v = await runVerification(cwd, { timeoutMs: 20000, enabled: true, consent: true, command: pol.policy.test_command });
    expect(v.ran).toBe(true);
    expect(v.passed).toBe(true);
    expect(v.basis).toBe('configured');
  });
});
