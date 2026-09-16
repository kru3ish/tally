import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { isolate, basicFixture, tmpDir } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { StubLlm } from '../src/llm/client.js';
import { parseTranscriptFile, readTranscriptLines, type Transcript } from '../src/transcript/parse.js';
import { reconstructChanges } from '../src/judge/reconstruct.js';
import { taskSourceOf } from '../src/judge/judge.js';
import { scanSessions } from '../src/backfill/scan.js';
import { backfillSession } from '../src/backfill/run.js';
import { eventsFromTranscript, replayCoach } from '../src/backfill/events.js';
import { gradeSession } from '../src/calibrate/grade.js';
import { readCalibration, buildCalibrationReport, renderCalibrationReport } from '../src/calibrate/calibrate.js';
import { intake, loadTask, confirmTask, renderTask } from '../src/task/intake.js';
import { buildContext } from '../src/coach/context.js';
import { taskConfirm } from '../src/coach/rules/task-confirm.js';
import { RULES } from '../src/coach/rules/index.js';
import { applySuggestion, injectSuggestion, isAutoApplicable } from '../src/coach/actions.js';
import { pendingInjects } from '../src/coach/inject.js';
import { renderSuggestion, watch } from '../src/coach/ui.js';
import { run as taskCommand } from '../src/commands/task.js';
import { computeTrend, renderTrend } from '../src/report/report.js';
import type { HistoryEntry } from '../src/coach/types.js';
import type { LinkDeps } from '../src/backfill/link.js';

let iso: ReturnType<typeof isolate>;
beforeEach(() => {
  iso = isolate();
});
afterEach(() => iso.restore());

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

const linkDeps: LinkDeps = {
  exec: (bin, args, cwd) => {
    const r = spawnSync(bin, args, { cwd, encoding: 'utf8' });
    return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  },
  ghOk: () => false,
};

const offlineFetch = { exec: () => ({ ok: false, stdout: '', stderr: '' }), fetch: async () => ({ ok: false, status: 0, text: async () => '' }), readFile: () => '', exists: () => false };

const call = (name: string, input: Record<string, unknown>, isError = false, agent = 'main') => ({ id: name + Math.random(), name, input, ts: '2026-09-10T14:05:00Z', agent, messageId: 'm', turn: 1, phase: 'work' as const, result: { isError, chars: 1, text: '' } });

describe('transcript-based diffs', () => {
  it('reconstructs Edit/MultiEdit/Write and shell edits, marking verified-against-disk vs reconstructed', () => {
    const cwd = 'C:\\repo';
    const t = {
      toolCalls: [
        call('Write', { file_path: 'C:\\repo\\src\\a.ts', content: 'export const a = 1;\n' }),
        call('Edit', { file_path: 'C:\\repo\\src\\b.ts', old_string: 'x', new_string: 'y' }),
        call('MultiEdit', { file_path: 'C:\\repo\\src\\c.ts', edits: [{ old_string: '1', new_string: '2' }, { old_string: '3', new_string: '4' }] }),
        call('Bash', { command: "sed -i 's/foo/bar/' src/d.ts" }),
        call('Bash', { command: 'git status && git diff' }),
        call('Bash', { command: 'npm test' }),
        call('Edit', { file_path: 'C:\\repo\\src\\err.ts', old_string: 'q', new_string: 'r' }, true),
        call('Write', { file_path: 'C:\\repo\\sub.ts', content: 'sub' }, false, 'subagent-1'),
      ],
    } as unknown as Transcript;
    const mixed = reconstructChanges(t, ['src/a.ts', 'src/c.ts'], cwd);
    expect(mixed.source).toBe('mixed');
    expect(mixed.verified).toEqual(['src/a.ts', 'src/c.ts']);
    expect(mixed.reconstructed).toEqual(['src/b.ts', 'src/d.ts']);
    expect(mixed.changes.filter((c) => c.kind === 'edit').length).toBe(3);
    expect(mixed.bash_edits.length).toBe(1);
    expect(mixed.bash_edits[0]!.file).toBe('src/d.ts');
    expect(mixed.changes.some((c) => c.file.includes('err.ts') || c.file.includes('sub.ts'))).toBe(false);
    expect(mixed.diff_text).toContain('+export const a = 1;');
    expect(mixed.diff_text).toContain('[verified-against-disk]');
    expect(mixed.diff_text).toContain('[reconstructed]');
    expect(mixed.diff_text).toContain('# shell-made change to src/d.ts');
    const none = reconstructChanges(t, [], cwd);
    expect(none.source).toBe('reconstructed');
    expect(none.verified).toEqual([]);
    expect(reconstructChanges({ toolCalls: [] } as unknown as Transcript, [], cwd).source).toBe('none');
    expect(reconstructChanges({ toolCalls: [] } as unknown as Transcript, ['x.ts'], cwd).source).toBe('git');
  });
});

describe('inferred tasks and receipts without a git tree', () => {
  /* a repo whose only commit lands after the session, so the window has no tree to check out and no link to find */
  function laterRepo(): string {
    const cwd = tmpDir('tally-inf-');
    git(cwd, ['init', '-q', '-b', 'feature/rate-limit']);
    git(cwd, ['config', 'user.email', 't@t']);
    git(cwd, ['config', 'user.name', 't']);
    fs.writeFileSync(path.join(cwd, 'README.md'), '# app\n');
    git(cwd, ['add', '-A']);
    git(cwd, ['commit', '-q', '-m', 'later work'], { GIT_AUTHOR_DATE: '2026-09-12T09:00:00Z', GIT_COMMITTER_DATE: '2026-09-12T09:00:00Z' });
    return cwd;
  }

  function unlinkedTranscript(cwd: string): string {
    const projects = path.join(iso.claude, 'projects');
    const pdir = path.join(projects, 'C--repo');
    fs.mkdirSync(pdir, { recursive: true });
    const lines = readTranscriptLines(path.join(basicFixture, 'transcript.jsonl')).lines.map((l) => ({ ...JSON.parse(JSON.stringify(l).replace(/https:\/\/github\.com\/acme\/app\/issues\/42/g, 'the login ticket')), cwd, gitBranch: 'feature/rate-limit' }));
    const transcript = path.join(pdir, 'inf-session-0001.jsonl');
    fs.writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return projects;
  }

  it('backfills without --task: intake infers from prompts + branch, the receipt is reconstructed, tests never run, and grading offers accept/edit', async () => {
    const cwd = laterRepo();
    const projects = unlinkedTranscript(cwd);
    const [cand] = scanSessions({ since: '2026-09-01', projectsDir: projects, now: Date.parse('2026-09-16T00:00:00Z') });
    const cfg = loadConfig();
    const llm = new StubLlm(
      {
        intake: () => ({ title: 'Rate limit the login endpoint', criteria: [{ text: 'Login returns 429 above the limit', source: 'inferred', check: { kind: 'none' } }, { text: 'A rate limit middleware exists', source: 'inferred', check: { kind: 'file_exists', path: 'src/middleware/rateLimit.ts' } }], spec_quality: { score: 8, missing: [], questions: [] }, estimate_hours: 1, rationale: '' }),
        judge: () => ({ criteria: [{ id: 'c1', status: 'met', evidence: 'rateLimit.ts returns 429 in the reconstructed write', files: ['src/middleware/rateLimit.ts'], confidence: 0.9 }], quality_score: 7, quality_reason: 'r', verdict_reason: 'v', recommendations: ['a', 'b', 'c'] }),
      },
      cand!.session,
    );
    const logs: string[] = [];
    const r = await backfillSession(cand!, { cfg, llm, deps: { link: linkDeps, ghOk: false, fetch: offlineFetch, followup: { exec: linkDeps.exec } }, log: (s) => logs.push(s) });
    expect(r.skipped).toBeUndefined();
    expect(r.link.kind).toBe('none');
    expect(r.window.notes.some((n) => n.includes('evidence reconstructed from the transcript'))).toBe(true);
    const intakeReq = llm.calls.find((c) => c.kind === 'intake')!;
    expect(intakeReq.prompt).toContain('BRANCH: feature/rate-limit');
    expect(intakeReq.prompt).toContain('no ticket: infer the task');
    const task = r.task!;
    expect(task.inferred).toBe(true);
    expect(task.confirmed).toBe(false);
    expect(task.context?.branch).toBe('feature/rate-limit');
    expect(renderTask(task)).toContain('inferred task (unconfirmed)');
    const j = r.judge!;
    expect(j.task.task_source).toBe('inferred');
    expect(j.evidence.diff_source).toBe('reconstructed');
    expect(j.evidence.reconstructed_files.some((f) => f.endsWith('rateLimit.ts'))).toBe(true);
    expect(j.evidence.bash_edits).toBe(0);
    expect(j.verification.ran).toBe(false);
    expect(j.verification.reason).toContain('real tree');
    expect(j.criteria.find((c) => c.id === 'c2')!.status).not.toBe('met');
    const judgeReq = llm.calls.find((c) => c.kind === 'judge')!;
    expect(judgeReq.prompt).toContain('RECONSTRUCTED FROM THE TRANSCRIPT');
    expect(judgeReq.prompt).toContain('+export function rateLimit');
    expect(logs.some((l) => l.includes('evidence: reconstructed from the transcript'))).toBe(true);
    expect(git(cwd, ['worktree', 'list']).split('\n').length).toBe(1);

    /* the Coach asks once for confirm / edit / link */
    const ctx = buildContext({ session: cand!.session, cwd, cfg, events: [] });
    const [s] = taskConfirm.evaluate(ctx);
    expect(s).toBeTruthy();
    expect(s!.action.kind).toBe('confirm');
    expect(s!.message).toContain('[c]onfirm');
    expect(s!.message).toContain('tally task --confirm');
    expect(isAutoApplicable(s!)).toBe(false);
    expect(renderSuggestion(s!, false)).toContain('[c]onfirm  [e]dit  [l]ink  [s]kip');

    /* blind grading shows the inferred criteria for accept/edit before any grade */
    const answers = ['e', 'Login answers 429 once the limit is hit', '', 'm', 'u', 'w', ...r.replay!.shown.map(() => 'u')];
    let out = '';
    const res = await gradeSession(cand!.session, { grader: 'alice', out: (s2) => (out += s2 + '\n'), ask: async () => answers.shift() ?? 'm' });
    expect(out).toContain('inferred from the prompts, branch "feature/rate-limit"');
    expect(res.entry.task_edited).toBe(true);
    expect(res.entry.task_source).toBe('inferred');
    expect(res.entry.criteria[0]!.text).toBe('Login answers 429 once the limit is hit');
    expect(res.entry.criteria[1]!.text).toBe('A rate limit middleware exists');
    const answers2 = ['a', 'm', 'm', 'w', ...r.replay!.shown.map(() => 'n')];
    const res2 = await gradeSession(cand!.session, { grader: 'bob', out: () => {}, ask: async () => answers2.shift() ?? 'm' });
    expect(res2.entry.task_edited).toBe(false);
    const rep = buildCalibrationReport(readCalibration().filter((e) => e.source === 'backfill'));
    expect(rep.by_task_source.find((b) => b.source === 'inferred')?.entries).toBe(2);
    expect(rep.by_task_source.find((b) => b.source === 'linked')).toBeUndefined();
    expect(renderCalibrationReport(rep, 'Backfill')).not.toContain('by task source');
    const mixed = buildCalibrationReport([...readCalibration(), { ...readCalibration()[0]!, session: 'other', task_source: 'linked' }]);
    expect(renderCalibrationReport(mixed, 'Backfill')).toMatch(/by task source\s+linked/);
    expect(renderCalibrationReport(mixed, 'Backfill')).toMatch(/by task source\s+inferred/);

    /* confirm through the CLI flag; the label and task_source follow */
    const code = await taskCommand({ _: [], flags: { confirm: true, session: cand!.session, cwd } });
    expect(code).toBe(0);
    const confirmed = loadTask(cand!.session)!;
    expect(confirmed.confirmed).toBe(true);
    expect(renderTask(confirmed)).toContain('inferred task (confirmed)');
    expect(taskSourceOf(confirmed, false)).toBe('confirmed');
    expect(taskConfirm.evaluate(buildContext({ session: cand!.session, cwd, cfg, events: [] })).length).toBe(0);
  });

  it('edit rewrites the task in the user\'s words and confirms it; the Coach [c] key confirms in place', async () => {
    const cwd = tmpDir('tally-edit-');
    const cfg = loadConfig();
    const session = 'edit-session-0001';
    const llm = new StubLlm({ intake: (req) => ({ title: req.prompt.includes('my words') ? 'Rewritten task' : 'Inferred task', criteria: [{ text: 'thing', source: 'inferred', check: { kind: 'none' } }], spec_quality: { score: 8, missing: [], questions: [] }, estimate_hours: 1, rationale: '' }) }, session);
    const first = await intake({ session, cwd, text: 'build the thing', cfg, llm, context: { branch: 'feature/x', commits: ['add thing'] } });
    expect(first.task.inferred).toBe(true);
    expect(llm.calls[0]!.prompt).toContain('COMMITS MADE DURING THE SESSION');
    const edited = await intake({ session, cwd, text: 'in my words: ship the thing', cfg, llm, force: true });
    expect(edited.task.title).toBe('Rewritten task');
    expect(edited.task.confirmed).toBe(false);
    expect(confirmTask(session)!.confirmed).toBe(true);
    expect(taskSourceOf(loadTask(session)!, false)).toBe('confirmed');

    /* fresh inferred task, confirmed from the Coach with the c key */
    const session2 = 'edit-session-0002';
    const llm2 = new StubLlm({ intake: () => ({ title: 'Inferred again', criteria: [{ text: 'thing', source: 'inferred', check: { kind: 'none' } }], spec_quality: { score: 8, missing: [], questions: [] }, estimate_hours: 1, rationale: '' }) }, session2);
    await intake({ session: session2, cwd, text: 'do it', cfg, llm: llm2 });
    const input = new PassThrough() as unknown as NodeJS.ReadStream & PassThrough;
    Object.assign(input, { isTTY: true, setRawMode: () => input });
    const outStream = new PassThrough();
    let printed = '';
    outStream.on('data', (d) => (printed += String(d)));
    input.write('c');
    await watch({ session: session2, cwd, cfg, color: false, pollMs: 10, maxTicks: 2, output: outStream as unknown as NodeJS.WriteStream, input });
    expect(printed).toContain('Inferred task (unconfirmed): Inferred again');
    expect(printed).toContain('[c]onfirm  [e]dit  [l]ink  [s]kip');
    expect(loadTask(session2)!.confirmed).toBe(true);
    expect(printed).toContain('confirmed');
    const r = applySuggestion({ rule: 'task-confirm', key: 'k', severity: 'info', title: 't', message: 'm', usd_saved: 0, action: { kind: 'confirm', label: 'Confirm' } }, { session: 'no-such-session', cwd, cfg, mode: 'ask' });
    expect(r.ok).toBe(false);
  });
});

describe('report breakdown by task source', () => {
  it('splits receipts into linked / confirmed / inferred and renders the block', () => {
    const repo = 'c:/repo';
    const h: HistoryEntry[] = [
      { ts: '2026-09-01T01:00:00Z', session: 'a', repo, verdict: 'worth it', completion_pct: 100, cost_usd: 2, linked: true, task_source: 'linked' },
      { ts: '2026-09-02T01:00:00Z', session: 'b', repo, verdict: 'borderline', completion_pct: 50, cost_usd: 4, linked: false, task_source: 'inferred', final_status: 'reverted' },
      { ts: '2026-09-03T01:00:00Z', session: 'c', repo, verdict: 'worth it', completion_pct: 80, cost_usd: 1, linked: false, task_source: 'confirmed' },
      { ts: '2026-09-04T01:00:00Z', session: 'd', repo, verdict: 'worth it', completion_pct: 60, cost_usd: 1, linked: false },
    ];
    const t = computeTrend({ repo, history: h });
    expect(t.by_task_source.map((b) => [b.source, b.tasks])).toEqual([['linked', 1], ['confirmed', 1], ['inferred', 2]]);
    expect(t.by_task_source.find((b) => b.source === 'inferred')!.rework_rate).toBe(1);
    const text = renderTrend(t, { repo });
    expect(text).toContain('linked');
    expect(text).toMatch(/inferred\s+2 task\(s\)\s+completion 55%/);
    expect(text).toContain('By task source');
  });
});

describe('inject wording', () => {
  it('every note handed to Claude is an observation prefixed "Tally observed", delivered under "Tally:"', () => {
    const t = parseTranscriptFile(path.join(basicFixture, 'transcript.jsonl'));
    const ev = eventsFromTranscript(t, 'inj', 'C:/repo', 'x.jsonl', 'abc');
    const cfg = loadConfig();
    const ctx = buildContext({ session: 'inj', cwd: 'C:/repo', cfg, events: ev, transcript: t, history: [] });
    const all = RULES.flatMap((rule) => rule.evaluate(ctx));
    const notes = all.map((s) => (s.action.kind === 'inject' ? s.action.note : s.inject_note)).filter((n): n is string => !!n);
    expect(notes.length).toBeGreaterThan(1);
    for (const n of notes) expect(n).toMatch(/^Tally observed /);
    expect(replayCoach({ session: 'inj', cwd: 'C:/repo', cfg, events: ev, transcript: t, history: [] }).shown.length).toBeGreaterThan(0);
    injectSuggestion({ rule: 'x', key: 'k', severity: 'info', title: 'Scope creep', message: 'Stick to the ticket.\nmore', usd_saved: 0, action: { kind: 'none', label: '' } }, { session: 'inj', cwd: 'C:/repo' });
    expect(pendingInjects('inj')[0]!.note).toBe('Tally observed: Scope creep. Stick to the ticket.');
  });
});
