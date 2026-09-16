import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isolate, basicFixture, tmpDir, root } from './helpers.js';
import { loadConfig, setTestRerunConsent } from '../src/config.js';
import { StubLlm } from '../src/llm/client.js';
import { parseTranscriptFile, readTranscriptLines } from '../src/transcript/parse.js';
import { scanSessions, parseSince, summarize } from '../src/backfill/scan.js';
import { detectTaskLink, keysIn, linkFromPrompts, type LinkDeps } from '../src/backfill/link.js';
import { reconstructWindow, addWorktree, runHistoricalTests, prepareDeps, HISTORICAL_UNRUNNABLE } from '../src/backfill/history.js';
import { eventsFromTranscript, replayCoach } from '../src/backfill/events.js';
import { ticketAsOf } from '../src/backfill/ticket.js';
import { backfillSession, projectCost } from '../src/backfill/run.js';
import { gradeSession, evidenceSummary } from '../src/calibrate/grade.js';
import { readCalibration, buildCalibrationReport, renderCalibrationReport } from '../src/calibrate/calibrate.js';
import { loadJudge } from '../src/judge/judge.js';
import type { FetchDeps } from '../src/task/fetchers.js';

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

/* A repo with dated commits: base before the session, one commit inside the window, one after. */
function datedRepo(): { cwd: string; base: string; inWindow: string; after: string } {
  const cwd = tmpDir('tally-bf-');
  git(cwd, ['init', '-q', '-b', 'feature/rate-limit']);
  git(cwd, ['config', 'user.email', 't@t']);
  git(cwd, ['config', 'user.name', 't']);
  const at = (iso: string) => ({ GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso });
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node test.js' } }));
  fs.writeFileSync(path.join(cwd, 'test.js'), 'if (require("./src.js") !== 429) process.exit(1)');
  fs.writeFileSync(path.join(cwd, 'src.js'), 'module.exports = 200;\n');
  fs.writeFileSync(path.join(cwd, 'README.md'), '# app\n');
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '-m', 'base'], at('2026-09-10T12:00:00Z'));
  const base = git(cwd, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(cwd, 'src.js'), 'module.exports = 429;\n');
  git(cwd, ['commit', '-q', '-am', 'add rate limiting APP-42 (#57)'], at('2026-09-10T14:15:00Z'));
  const inWindow = git(cwd, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(cwd, 'src.js'), 'module.exports = 500;\n');
  git(cwd, ['commit', '-q', '-am', 'later unrelated work'], at('2026-09-12T09:00:00Z'));
  const after = git(cwd, ['rev-parse', 'HEAD']);
  return { cwd, base, inWindow, after };
}

const linkDeps = (extra: Partial<LinkDeps> = {}): LinkDeps => ({
  exec: (bin, args, cwd) => {
    const r = spawnSync(bin, args, { cwd, encoding: 'utf8' });
    return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  },
  ghOk: () => false,
  ...extra,
});

describe('backfill scan', () => {
  it('parses --since and lists sessions from a projects dir, skipping internal runs', () => {
    const now = Date.parse('2026-09-16T00:00:00Z');
    expect(parseSince('60d', now)).toBe(now - 60 * 86400000);
    expect(parseSince('2w', now)).toBe(now - 14 * 86400000);
    expect(parseSince('2026-09-01', now)).toBe(Date.parse('2026-09-01'));
    expect(() => parseSince('soon')).toThrow();
    const projects = path.join(iso.claude, 'projects');
    fs.mkdirSync(path.join(projects, 'C--Users-dev-acme-app'), { recursive: true });
    fs.mkdirSync(path.join(projects, 'C--tmp-tally-llm-abc'), { recursive: true });
    fs.copyFileSync(path.join(basicFixture, 'transcript.jsonl'), path.join(projects, 'C--Users-dev-acme-app', 'fx.jsonl'));
    fs.copyFileSync(path.join(basicFixture, 'transcript.jsonl'), path.join(projects, 'C--tmp-tally-llm-abc', 'internal.jsonl'));
    const s = summarize(path.join(projects, 'C--Users-dev-acme-app', 'fx.jsonl'))!;
    expect(s.cost).toBeGreaterThan(1);
    expect(s.prompts.length).toBe(2);
    expect(s.branch).toBe('feature/rate-limit');
    const list = scanSessions({ since: '2026-09-01', projectsDir: projects, now: Date.parse('2026-09-16T00:00:00Z') });
    expect(list.length).toBe(1);
    expect(list[0]!.session).toBe('fx-basic-0001-4c0d-8e1a-000000000001');
    expect(scanSessions({ since: '2026-09-01', repo: 'C:/nowhere', projectsDir: projects, now: Date.parse('2026-09-16T00:00:00Z') }).length).toBe(0);
    expect(fs.existsSync(path.join(iso.home, 'backfill', 'index.json'))).toBe(true);
  });
});

describe('task link detection', () => {
  it('prefers a URL in the prompt, then keys in branch or commits, and reports confidence', () => {
    expect(linkFromPrompts(['fix https://github.com/acme/app/issues/42 now'])!.url).toBe('https://github.com/acme/app/issues/42');
    expect(keysIn('feature/APP-42-rate-limit')).toEqual({ keys: ['APP-42'], hashes: [] });
    expect(keysIn('fix #57 and #58; UTF-8 unaffected')).toEqual({ keys: [], hashes: ['57', '58'] });
    const { cwd } = datedRepo();
    const byUrl = detectTaskLink({ cwd, branch: 'x', prompts: ['see https://acme.atlassian.net/browse/APP-9'] }, linkDeps());
    expect(byUrl).toMatchObject({ kind: 'url', confidence: 0.9 });
    const byBranch = detectTaskLink({ cwd, branch: 'feature/APP-77-thing', prompts: ['do the thing'] }, linkDeps());
    expect(byBranch).toMatchObject({ kind: 'key', ref: 'APP-77', confidence: 0.6 });
    const byCommit = detectTaskLink({ cwd, branch: 'feature/rate-limit', prompts: ['add rate limiting'], start: '2026-09-10T14:00:00Z', end: '2026-09-10T15:00:00Z' }, linkDeps());
    expect(byCommit).toMatchObject({ kind: 'key', ref: 'APP-42', confidence: 0.6 });
    expect(byCommit.evidence).toContain('commit message');
    const none = detectTaskLink({ cwd, branch: 'feature/rate-limit', prompts: ['hello'], start: '2026-09-11T00:00:00Z', end: '2026-09-11T01:00:00Z' }, linkDeps());
    expect(none.kind).toBe('none');
    expect(none.evidence).toContain('gh unavailable');
    const byPr = detectTaskLink({ cwd, branch: 'feature/rate-limit', prompts: ['hello'], start: '2026-09-11T00:00:00Z', end: '2026-09-11T01:00:00Z' }, linkDeps({ ghOk: () => true, exec: (bin, args, c) => (bin === 'gh' ? { ok: true, stdout: JSON.stringify([{ number: 57, url: 'https://github.com/acme/app/pull/57', title: 'Rate limit', state: 'MERGED' }]), stderr: '' } : linkDeps().exec(bin, args, c)) }));
    expect(byPr).toMatchObject({ kind: 'pr', confidence: 0.7, url: 'https://github.com/acme/app/pull/57' });
  });
});

describe('history reconstruction', () => {
  it('finds the start and end HEADs from the session window and builds a disposable worktree', async () => {
    const { cwd, base, inWindow, after } = datedRepo();
    const w = reconstructWindow(cwd, { branch: 'feature/rate-limit', start: '2026-09-10T14:00:00Z', end: '2026-09-10T15:00:00Z', ghOk: false });
    expect(w.start_head).toBe(base);
    expect(w.end_head).toBe(inWindow);
    expect(w.end_head).not.toBe(after);
    expect(w.commits_in_window).toBe(1);
    const gone = reconstructWindow(cwd, { branch: 'deleted-branch', start: '2026-09-10T14:00:00Z', end: '2026-09-10T15:00:00Z', ghOk: false });
    expect(gone.notes[0]).toContain('no longer exists');
    expect(gone.end_head).toBe(inWindow);
    const empty = reconstructWindow(cwd, { branch: 'feature/rate-limit', start: '2026-09-11T00:00:00Z', end: '2026-09-11T01:00:00Z', ghOk: false });
    expect(empty.commits_in_window).toBe(0);
    expect(empty.notes.some((n) => n.includes('no commits inside'))).toBe(true);
    const wt = addWorktree(cwd, inWindow);
    expect(fs.readFileSync(path.join(wt.path, 'src.js'), 'utf8')).toContain('429');
    expect(fs.readFileSync(path.join(cwd, 'src.js'), 'utf8')).toContain('500');
    const ver = await runHistoricalTests(wt.path, { consent: true, timeoutMs: 30000 });
    expect(ver.ran).toBe(true);
    expect(ver.passed).toBe(true);
    expect(ver.basis).toContain('historical worktree');
    const denied = await runHistoricalTests(wt.path, { consent: false, timeoutMs: 1000 });
    expect(denied.ran).toBe(false);
    wt.remove();
    expect(fs.existsSync(wt.path)).toBe(false);
    expect(git(cwd, ['worktree', 'list'])).not.toContain('tally-wt-');
  });

  it('marks tests unrunnable when dependencies cannot be installed offline', async () => {
    const wt = tmpDir('tally-deps-');
    fs.writeFileSync(path.join(wt, 'package.json'), JSON.stringify({ scripts: { test: 'node test.js' }, dependencies: { 'left-pad': '1.0.0' } }));
    fs.writeFileSync(path.join(wt, 'test.js'), 'process.exit(0)');
    const d = await prepareDeps(wt, 5000);
    expect(d.ok).toBe(false);
    expect(d.note).toContain('no lockfile');
    const ver = await runHistoricalTests(wt, { consent: true, timeoutMs: 5000 });
    expect(ver.ran).toBe(false);
    expect(ver.reason!.startsWith(HISTORICAL_UNRUNNABLE)).toBe(true);
  });
});

describe('event synthesis and coach replay', () => {
  it('rebuilds hook-style events from a transcript and replays the rules with noise limits', () => {
    const t = parseTranscriptFile(path.join(basicFixture, 'transcript.jsonl'));
    const ev = eventsFromTranscript(t, 'bf', 'C:/repo', 'x.jsonl', 'abc');
    const types = ev.map((e) => e.type);
    expect(types[0]).toBe('session_start');
    expect(types.at(-1)).toBe('session_end');
    expect(types.filter((x) => x === 'prompt').length).toBe(2);
    expect(types.filter((x) => x === 'ship').length).toBe(2);
    expect(types.filter((x) => x === 'pre_compact').length).toBe(1);
    expect(ev.filter((e) => e.type === 'post_tool' && e.data.is_error).length).toBe(6);
    expect((ev[0]!.data.loaded as { mcp: string[] }).mcp).toContain('jira');
    const cfg = loadConfig();
    const r = replayCoach({ session: 'bf', cwd: 'C:/repo', cfg, events: ev, transcript: t, history: [] });
    expect(r.shown.length).toBeGreaterThanOrEqual(3);
    expect(r.shown.map((s) => s.rule)).toContain('loop-detect');
    expect(r.shown.filter((s) => s.severity !== 'critical').length).toBeLessThanOrEqual(cfg.coach.max_per_session);
    expect(new Set(r.shown.map((s) => s.key)).size).toBe(r.shown.length);
    expect(r.note).toContain('LLM coach pass is not replayed');
  });
});

describe('ticket as of session start', () => {
  it('reconstructs Jira text from the changelog and GitHub titles from renames', async () => {
    const cfg = loadConfig();
    cfg.jira = { base_url: 'https://acme.atlassian.net', email: 'e', api_token: 't' };
    const deps: FetchDeps = { exec: () => ({ ok: false, stdout: '', stderr: '' }), readFile: () => '', exists: () => false, fetch: async (url) => ({ ok: true, status: 200, text: async () => (url.includes('/changelog') ? JSON.stringify({ isLast: true, values: [{ created: '2026-09-11T10:00:00Z', items: [{ field: 'summary', fromString: 'Old title', toString: 'New title' }, { field: 'description', fromString: 'old body', toString: 'new body' }] }, { created: '2026-09-01T10:00:00Z', items: [{ field: 'summary', fromString: 'Older', toString: 'Old title' }] }] }) : '{}') }) };
    const j = await ticketAsOf({ source: { kind: 'jira', ref: 'APP-1', key: 'APP-1' }, title: 'New title', body: 'new body', labels: [] }, '2026-09-10T14:00:00Z', cfg, deps);
    expect(j).toMatchObject({ title: 'Old title', body: 'old body', as_of: 'session_start' });
    const gh: FetchDeps = { ...deps, exec: (bin, args) => (args[1]?.includes('/timeline') ? { ok: true, stdout: JSON.stringify([{ created_at: '2026-09-12T00:00:00Z', from: 'Original title', to: 'Renamed title' }]), stderr: '' } : { ok: true, stdout: JSON.stringify({ data: { repository: { issue: { userContentEdits: { nodes: [{ editedAt: '2026-09-09T00:00:00Z', diff: 'body before session' }, { editedAt: '2026-09-13T00:00:00Z', diff: 'body after' }] } } } } }), stderr: '' }) };
    const g = await ticketAsOf({ source: { kind: 'github', ref: 'x', owner: 'acme', repo: 'app', number: 42 }, title: 'Renamed title', body: 'body after', labels: [] }, '2026-09-10T14:00:00Z', cfg, gh);
    expect(g.title).toBe('Original title');
    expect(g.body).toBe('body before session');
    expect(g.as_of).toBe('session_start');
    const plain = await ticketAsOf({ source: { kind: 'text', ref: 'x' }, title: 't', body: 'b', labels: [] }, '2026-09-10T14:00:00Z', cfg, deps);
    expect(plain.as_of).toBe('current');
  });
});

describe('backfill end to end and blind grading', () => {
  it('reconstructs, judges in a worktree, follows up, replays the coach, then grades blind', async () => {
    const { cwd, base, inWindow } = datedRepo();
    const projects = path.join(iso.claude, 'projects');
    const pdir = path.join(projects, 'C--repo');
    fs.mkdirSync(pdir, { recursive: true });
    const lines = readTranscriptLines(path.join(basicFixture, 'transcript.jsonl')).lines.map((l) => ({ ...l, cwd, gitBranch: 'feature/rate-limit' }));
    const transcript = path.join(pdir, 'bf-session-0001.jsonl');
    fs.writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const [cand] = scanSessions({ since: '2026-09-01', projectsDir: projects, now: Date.parse('2026-09-16T00:00:00Z') });
    expect(cand!.cwd).toBe(cwd);
    setTestRerunConsent(cwd, true);
    const cfg = loadConfig();
    const llm = new StubLlm(
      {
        intake: (req) => ({ title: req.prompt.includes('TITLE: Rate limit') ? 'Rate limit login' : 'Task', criteria: [{ text: 'Login returns 429 above the limit', source: 'explicit', check: { kind: 'file_contains', path: 'src.js', pattern: '429' } }, { text: 'README documents the limit', source: 'explicit', check: { kind: 'file_changed', path: 'README.md' } }, { text: 'Limiter resets after 15 minutes', source: 'explicit', check: { kind: 'none' } }, { text: 'Tests pass', source: 'inferred', check: { kind: 'tests_pass' } }], spec_quality: { score: 6, missing: [], questions: [] }, estimate_hours: 2, rationale: '' }),
        judge: () => ({ criteria: [{ id: 'c3', status: 'unmet', evidence: 'no window logic in src.js', files: ['src.js'], confidence: 0.9 }], quality_score: 6, quality_reason: 'r', verdict_reason: 'v', recommendations: ['a', 'b', 'c'] }),
      },
      cand!.session,
    );
    const proj = projectCost([cand!], cfg);
    expect(proj.total_usd).toBeGreaterThan(0);
    expect(proj.tier2_sessions).toBe(0);
    const logs: string[] = [];
    const r = await backfillSession(cand!, { cfg, llm, deps: { link: linkDeps(), ghOk: false, fetch: { exec: () => ({ ok: false, stdout: '', stderr: '' }), fetch: async () => ({ ok: false, status: 0, text: async () => '' }), readFile: () => '', exists: () => false }, followup: { exec: (b, a, c) => linkDeps().exec(b, a, c) } }, log: (s) => logs.push(s) });
    expect(r.skipped).toBeUndefined();
    expect(r.link).toMatchObject({ kind: 'url', confidence: 0.9 });
    expect(r.window.start_head).toBe(base);
    expect(r.window.end_head).toBe(inWindow);
    const j = r.judge!;
    expect(j.cwd).toBe(cwd);
    expect(j.historical?.start_head).toBe(base);
    expect(j.criteria.map((c) => [c.id, c.status, c.resolved_by])).toEqual([['c1', 'met', 'tier0'], ['c2', 'unmet', 'tier0'], ['c3', 'unmet', 'tier1'], ['c4', 'met', 'tier0']]);
    expect(j.verification.ran).toBe(true);
    expect(j.verification.passed).toBe(true);
    expect(j.evidence.files_changed).toEqual(['src.js']);
    expect(j.followup).toBeTruthy();
    expect(r.task!.historical?.ticket_as_of).toBe('current');
    expect(fs.existsSync(path.join(iso.home, 'sessions', cand!.session, 'coach_replay.json'))).toBe(true);
    expect(fs.existsSync(path.join(iso.home, 'sessions', cand!.session, 'backfill.json'))).toBe(true);
    expect(r.replay!.shown.length).toBeGreaterThan(0);
    expect(git(cwd, ['worktree', 'list']).split('\n').length).toBe(1);
    expect(fs.readFileSync(path.join(cwd, 'src.js'), 'utf8')).toContain('500');
    expect(r.tally_spend_usd).toBeGreaterThan(0);
    expect(logs.some((l) => l.includes('coach replay'))).toBe(true);

    const summary = evidenceSummary(cand!.session);
    expect(summary).toContain('Criteria (frozen at intake)');
    expect(summary).toContain('tests: npm test → passed');
    expect(summary).not.toMatch(/\bmet\b.*tier|verdict:/);
    const answers = ['m', 'u', 'p', 'm', 'b', ...r.replay!.shown.map((_, i) => (i % 2 ? 'n' : 'u'))];
    let shownBeforeGrades = '';
    let out = '';
    const res = await gradeSession(cand!.session, { grader: 'alice', out: (s) => (out += s + '\n'), ask: async () => { if (!shownBeforeGrades) shownBeforeGrades = out; return answers.shift() ?? 'm'; } });
    expect(shownBeforeGrades).not.toContain(j.verdict.verdict);
    expect(shownBeforeGrades).not.toContain('tally');
    expect(res.entry.criteria.map((c) => c.human)).toEqual(['met', 'unmet', 'partial', 'met']);
    expect(res.entry.grader).toBe('alice');
    expect(res.entry.source).toBe('backfill');
    expect(res.entry.coach!.length).toBe(r.replay!.shown.length);
    expect(res.reveal).toContain('side by side');
    expect(res.reveal).toContain(j.verdict.verdict);
    const answers2 = ['m', 'u', 'u', 'm', 'n', ...r.replay!.shown.map(() => 'u')];
    await gradeSession(cand!.session, { grader: 'bob', out: () => {}, ask: async () => answers2.shift() ?? 'm' });
    const entries = readCalibration().filter((e) => e.source === 'backfill');
    expect(entries.length).toBe(2);
    const rep = buildCalibrationReport(entries);
    expect(rep.inter_grader).toMatchObject({ sessions: 1, criteria: 4 });
    expect(rep.inter_grader!.agreement).toBe(0.75);
    expect(rep.lean.stricter + rep.lean.lenient + rep.lean.same).toBe(8);
    expect(rep.coach.total).toBe(r.replay!.shown.length * 2);
    const text = renderCalibrationReport(rep, 'Backfill');
    expect(text).toContain('inter-grader          75%');
    expect(text).toContain('coach precision');
    expect(text).toContain('lean');
    const cli = spawnSync(process.execPath, [path.join(root, 'dist', 'cli.js'), 'calibrate', 'report', '--source', 'backfill'], { encoding: 'utf8', env: { ...process.env } });
    expect(cli.stdout).toContain('Backfill calibration');
    expect(cli.stdout).not.toContain('Fixture regression baseline');
    expect(loadJudge(cand!.session)!.followup!.final_status).toBeDefined();
  }, 120000);
});
