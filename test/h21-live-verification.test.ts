/* Regressions from the first live verification on Windows (session cfe9bd83, task tasks/readme-windows.md): every
   command must name a session the same way, verify must judge the session's repository and not the shell's, shell
   edits must count, a stale receipt must not be reused, and the contract must say what it is. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isolate, root, basicFixture, tmpDir } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { StubLlm } from '../src/llm/client.js';
import { intake, loadTask, confirmTask, listedCriteria, listedSection } from '../src/task/intake.js';
import { judgeSession, existingReceiptFor, loadJudge, workingTreeHash, renderSummary } from '../src/judge/judge.js';
import { readEventsFile, appendEvent, type TallyEvent } from '../src/store/events.js';
import { resolveSessionId, resolveSession, uniquePrefixLength, sessionCwd, SessionNotFound } from '../src/session.js';
import { shellWrittenFiles, collectEvidence } from '../src/judge/evidence.js';
import { contractFromTask, renderContract } from '../src/core/contract.js';
import { parseTranscriptFile } from '../src/transcript/parse.js';
import { sessionDir, ensureDir } from '../src/paths.js';
import type { FetchDeps } from '../src/task/fetchers.js';

const CLI = path.join(root, 'dist', 'cli.js');
let iso: ReturnType<typeof isolate>;
beforeEach(() => {
  iso = isolate();
});
afterEach(() => iso.restore());

const deps = { exec: () => ({ ok: false, stdout: '', stderr: '' }), fetch: async () => ({ ok: false, status: 0, text: async () => '' }), readFile: () => '', exists: () => false } as FetchDeps;
const GIT_ENV = { ...process.env, GIT_AUTHOR_EMAIL: 't@t', GIT_AUTHOR_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_COMMITTER_NAME: 't' };
function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

/* a repository with a base commit, then README and CHANGELOG edited through the shell, exactly like the live session */
function repoEditedByShell(): { cwd: string; base: string } {
  const cwd = tmpDir('tally-live-');
  git(cwd, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'app', scripts: { test: 'node -e "console.log(\'1 passing\')"' } }));
  fs.writeFileSync(path.join(cwd, 'README.md'), '# app\n\n## Install\n\nnpm i -g app\n');
  fs.writeFileSync(path.join(cwd, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n');
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '-m', 'base']);
  const base = git(cwd, ['rev-parse', 'HEAD']);
  fs.appendFileSync(path.join(cwd, 'README.md'), '\n**Windows:** run `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned` or call `tally.cmd`.\n');
  fs.appendFileSync(path.join(cwd, 'CHANGELOG.md'), '- README: Windows execution policy note\n');
  return { cwd, base };
}

/* hook events as the live session recorded them: session_start with the repo cwd and git_head, then Bash tool calls */
function seedSession(session: string, cwd: string, base: string, opts: { toolTs?: string; transcript?: boolean } = {}): void {
  ensureDir(sessionDir(session));
  const t = opts.toolTs ?? '2026-09-28T18:24:00.000Z';
  const events: TallyEvent[] = [
    { ts: '2026-09-28T18:22:57.000Z', type: 'session_start', session, cwd, data: { source: 'startup', agent: 'claude-code', git_head: base, transcript_path: path.join(sessionDir(session), 'transcript.jsonl') } },
    { ts: '2026-09-28T18:23:00.000Z', type: 'prompt', session, cwd, data: { prompt: 'Read tasks/readme-windows.md and do it' } },
    { ts: t, type: 'pre_tool', session, cwd, data: { tool_name: 'Bash', tool_input: { command: "python -c \"p='README.md'; s=open(p).read(); open(p,'w').write(s)\"" }, tool_use_id: 't1' } },
    { ts: t, type: 'post_tool', session, cwd, data: { tool_name: 'Bash', tool_input: { command: "python -c \"p='README.md'; s=open(p).read(); open(p,'w').write(s)\"" }, tool_use_id: 't1' } },
  ];
  for (const e of events) appendEvent(e);
  if (opts.transcript !== false) fs.copyFileSync(path.join(basicFixture, 'transcript.jsonl'), path.join(sessionDir(session), 'transcript.jsonl'));
}

const stub = (constraints: string[] = []) => ({
  intake: () => ({
    title: 'Add Windows install note to README',
    criteria: [
      { text: 'README.md install section includes a Windows note describing the execution policy issue', source: 'explicit' },
      { text: 'The Windows note includes the Set-ExecutionPolicy command with the RemoteSigned scope parameter', source: 'explicit' },
      { text: 'The note documents tally.cmd and npm.cmd as an alternative', source: 'explicit' },
      { text: 'CHANGELOG.md has an entry under unreleased', source: 'explicit', check: { kind: 'file_changed', path: 'CHANGELOG.md' } },
    ],
    spec_quality: { score: 8, missing: [], questions: [] },
    estimate_hours: 1,
    rationale: 'x',
    constraints,
  }),
  judge: () => ({ criteria: [{ id: 'c1', status: 'met', evidence: 'README.md gained a Windows note', files: ['README.md'], confidence: 0.9 }, { id: 'c2', status: 'met', evidence: 'the command is there', files: ['README.md'], confidence: 0.9 }, { id: 'c3', status: 'met', evidence: 'tally.cmd is mentioned', files: ['README.md'], confidence: 0.9 }], quality_score: 7, quality_reason: 'r', verdict_reason: 'v', recommendations: ['a', 'b', 'c'] }),
  review: () => ({ layer: 'at_root_cause', layer_note: '', blast_radius: 'contained', blast_note: '', untested_surface: [], merge: 'merge', note: '' }),
});

const TASK_MD = `# Add Windows install note to README

Windows PowerShell blocks npm's launcher scripts by default.

## Acceptance criteria
1. The README install section has a short "Windows" note describing this error.
2. The note shows the fix: \`Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned\`.
3. The note shows the no-settings alternative: run \`tally.cmd\` (and \`npm.cmd\`) instead.
4. CHANGELOG.md has an entry for this under the unreleased section.

## Constraints
- Only README.md and CHANGELOG.md change.
`;

describe('one session-id rule for every command', () => {
  it('resolves a unique prefix, rejects an ambiguous or unknown one, and accepts a full id with no directory yet', () => {
    ensureDir(sessionDir('cfe9bd83-6f9c-4df7-bbac-5013a1a6dc8e'));
    ensureDir(sessionDir('01a0e923-702c-74d3-ba79-1b3bedc32f8e'));
    ensureDir(sessionDir('01a0e923-7100-7e00-9272-7d5582807c2d'));
    expect(resolveSessionId('cfe9bd83')).toBe('cfe9bd83-6f9c-4df7-bbac-5013a1a6dc8e');
    expect(resolveSession('cfe9')).toBe('cfe9bd83-6f9c-4df7-bbac-5013a1a6dc8e');
    expect(() => resolveSessionId('01a0e923')).toThrow(/matches 2 sessions/);
    expect(resolveSessionId('01a0e923-71')).toBe('01a0e923-7100-7e00-9272-7d5582807c2d');
    expect(() => resolveSessionId('deadbeef')).toThrow(SessionNotFound);
    expect(resolveSessionId('9d3a2c11-0000-4000-8000-000000000001')).toBe('9d3a2c11-0000-4000-8000-000000000001');
    expect(uniquePrefixLength(['01a0e923-702c-74d3-ba79-1b3bedc32f8e', '01a0e923-7100-7e00-9272-7d5582807c2d', 'cfe9bd83-6f9c-4df7-bbac-5013a1a6dc8e'])).toBe(11);
  });

  it('status on a session that does not exist is an error, and judge with a prefix finds the transcript', () => {
    const env = { ...process.env, TALLY_HOME: iso.home, CLAUDE_CONFIG_DIR: iso.claude, TALLY_LLM: 'stub' };
    const missing = spawnSync(process.execPath, [CLI, 'status', '--session', 'cfe9bd83'], { encoding: 'utf8', env });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/no session starting with "cfe9bd83"/);
    const { cwd, base } = repoEditedByShell();
    seedSession('cfe9bd83-6f9c-4df7-bbac-5013a1a6dc8e', cwd, base);
    const st = spawnSync(process.execPath, [CLI, 'status', '--session', 'cfe9bd83', '--plain'], { encoding: 'utf8', env });
    expect(st.status).toBe(0);
    expect(st.stdout).toContain('cfe9bd83-6f9c-4df7-bbac-5013a1a6dc8e');
    expect(st.stdout).not.toMatch(/sessions[\\/]cfe9bd83(?![0-9a-f-])/);
    const j = spawnSync(process.execPath, [CLI, 'judge', 'cfe9bd83', '--plain'], { cwd: iso.home, encoding: 'utf8', env });
    expect(j.stdout + j.stderr).not.toMatch(/No transcript found/);
    expect(j.status).toBe(0);
    const stored = loadJudge('cfe9bd83-6f9c-4df7-bbac-5013a1a6dc8e')!;
    expect(stored.cwd).toBe(cwd);
    const list = spawnSync(process.execPath, [CLI, 'sessions'], { encoding: 'utf8', env });
    expect(list.stdout).toContain('cfe9bd83');
  });
});

describe('verify judges the repository the session ran in', () => {
  it('from another directory, the diff and the tests come from the session cwd, and the shell edits count', async () => {
    const { cwd, base } = repoEditedByShell();
    const session = 'live-verify-1';
    seedSession(session, cwd, base);
    const cfg = loadConfig();
    const llm = new StubLlm(stub(), session);
    await intake({ session, cwd, text: TASK_MD, cfg, llm, deps });
    const elsewhere = tmpDir('tally-elsewhere-');
    const env = { ...process.env, TALLY_HOME: iso.home, CLAUDE_CONFIG_DIR: iso.claude, TALLY_LLM: 'stub' };
    const r = spawnSync(process.execPath, [CLI, 'verify', session, '--plain'], { cwd: elsewhere, encoding: 'utf8', env });
    expect(r.stderr).toMatch(/ran in .*using that repository/);
    const j = loadJudge(session)!;
    expect(j.cwd).toBe(cwd);
    expect(j.evidence.files_changed).toEqual(expect.arrayContaining(['README.md', 'CHANGELOG.md']));
    expect(j.evidence.diff_stat).toMatch(/README\.md/);
    expect(r.stdout).toMatch(/CHANGELOG\.md is in the diff/);
    expect(r.stdout).not.toMatch(/no edits were applied/);
  });

  it('files an agent writes through the shell are edited files even without git', () => {
    const cwd = tmpDir('tally-shell-');
    fs.writeFileSync(path.join(cwd, 'README.md'), '# r\n');
    fs.writeFileSync(path.join(cwd, 'CHANGELOG.md'), '# c\n');
    expect(shellWrittenFiles("sed -i 's/a/b/' README.md", cwd)).toEqual(['README.md']);
    expect(shellWrittenFiles("python -c \"p='CHANGELOG.md'; s=open(p,encoding='utf-8').read(); open(p,'w',encoding='utf-8').write(s + 'x')\"", cwd)).toEqual(['CHANGELOG.md']);
    expect(shellWrittenFiles('echo hi > notes.txt', cwd)).toEqual([]);
    expect(shellWrittenFiles('cat README.md | head -20', cwd)).toEqual([]);
    expect(shellWrittenFiles("grep -n 'Windows' README.md", cwd)).toEqual([]);
    const t = parseTranscriptFile(path.join(basicFixture, 'transcript.jsonl'));
    t.toolCalls.push({ ...t.toolCalls[0]!, name: 'Bash', input: { command: "sed -i 's/x/y/' README.md" }, result: { text: '', isError: false } });
    const ev = collectEvidence({ cwd, transcript: t, events: [], skipGit: true });
    expect(ev.edited_files).toContain('README.md');
  });
});

describe('a stored receipt is reused only while nothing it depends on has moved', () => {
  it('a replaced contract or an uncommitted edit invalidates it', async () => {
    const { cwd, base } = repoEditedByShell();
    git(cwd, ['commit', '-q', '-am', 'work']);
    const session = 'live-cache-1';
    seedSession(session, cwd, base);
    const cfg = loadConfig();
    cfg.judge.maintainer_review = 'off';
    const llm = new StubLlm(stub(), session);
    await intake({ session, cwd, text: TASK_MD, cfg, llm, deps });
    const events = readEventsFile(path.join(sessionDir(session), 'events.jsonl'));
    const j = await judgeSession({ session, cwd, transcriptPath: path.join(sessionDir(session), 'transcript.jsonl'), cfg, llm, reason: 'manual', events, consent: true });
    expect(j.task.frozen_at).toBe(loadTask(session)!.created_at);
    expect(j.tree_hash).toBe(workingTreeHash(cwd));
    expect(existingReceiptFor(session, cwd)).toBeTruthy();
    /* an uncommitted edit: the receipt no longer describes the tree */
    fs.appendFileSync(path.join(cwd, 'README.md'), 'more\n');
    expect(existingReceiptFor(session, cwd)).toBeNull();
    git(cwd, ['commit', '-q', '-am', 'more']);
    /* a re-frozen contract (tally task --force): the receipt answers an older question */
    await new Promise((r) => setTimeout(r, 5));
    await intake({ session, cwd, text: TASK_MD + '\n5. A fifth thing.\n', cfg, llm, deps, force: true });
    const j2 = await judgeSession({ session, cwd, transcriptPath: path.join(sessionDir(session), 'transcript.jsonl'), cfg, llm, reason: 'manual', events, consent: true });
    expect(existingReceiptFor(session, cwd)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 5));
    await intake({ session, cwd, text: TASK_MD, cfg, llm, deps, force: true });
    expect(loadTask(session)!.created_at).not.toBe(j2.task.frozen_at);
    expect(existingReceiptFor(session, cwd)).toBeNull();
  });
});

describe('the contract says what it is', () => {
  it('criteria are frozen verbatim from the source, model constraints are labelled inferred, and the status is explicit', async () => {
    const { cwd, base } = repoEditedByShell();
    const session = 'live-contract-1';
    seedSession(session, cwd, base);
    const cfg = loadConfig();
    const llm = new StubLlm(stub(['Only modify README.md and CHANGELOG.md; do not change any other files', 'Do not remove or replace existing installation instructions']), session);
    /* from a file, as the live session did: a linked source, not an inferred one */
    fs.mkdirSync(path.join(cwd, 'tasks'));
    fs.writeFileSync(path.join(cwd, 'tasks', 'readme-windows.md'), TASK_MD);
    const { task } = await intake({ session, cwd, ref: path.join(cwd, 'tasks', 'readme-windows.md'), cfg, llm });
    expect(task.source.kind).toBe('file');
    expect(task.criteria.map((c) => c.text)).toEqual(['The README install section has a short "Windows" note describing this error.', 'The note shows the fix: `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`.', 'The note shows the no-settings alternative: run `tally.cmd` (and `npm.cmd`) instead.', 'CHANGELOG.md has an entry for this under the unreleased section.']);
    expect(task.criteria[1]!.text).toContain('-Scope CurrentUser');
    expect(task.criteria.every((c) => c.source === 'explicit')).toBe(true);
    expect(task.criteria[3]!.check?.kind).toBe('file_changed');
    expect(task.constraints).toContain('Only README.md and CHANGELOG.md change.');
    expect(task.constraints_inferred).toEqual(['Do not remove or replace existing installation instructions']);
    const c = contractFromTask(task, { cwd });
    expect(c.status).toBe('linked');
    const text = renderContract(c);
    expect(text).toContain('Status: LINKED (from the source, not confirmed by a person)');
    expect(text).toMatch(/Do not remove or replace existing installation instructions  \(inferred by the intake model, not in the source\)/);
    expect(text).not.toMatch(/Only README\.md and CHANGELOG\.md change\.  \(inferred/);
    confirmTask(session);
    expect(contractFromTask(loadTask(session)!, { cwd }).status).toBe('confirmed');
    expect(listedCriteria(TASK_MD).length).toBe(4);
    expect(listedSection('no headings here\n- a\n', /criteria/)).toEqual([]);
  });

  it('a contract frozen after the last edit is said so on the receipt', async () => {
    const { cwd, base } = repoEditedByShell();
    git(cwd, ['commit', '-q', '-am', 'work']);
    const session = 'live-late-1';
    seedSession(session, cwd, base, { toolTs: '2026-09-28T18:24:00.000Z' });
    const cfg = loadConfig();
    cfg.judge.maintainer_review = 'off';
    const llm = new StubLlm(stub(), session);
    await intake({ session, cwd, text: TASK_MD, cfg, llm, deps });
    const events = readEventsFile(path.join(sessionDir(session), 'events.jsonl'));
    const j = await judgeSession({ session, cwd, transcriptPath: path.join(sessionDir(session), 'transcript.jsonl'), cfg, llm, reason: 'manual', events, consent: true });
    expect(j.task.frozen_after_work).toBeTruthy();
    expect(j.task.frozen_after_work!.last_edit_at).toBe('2026-09-28T18:24:00.000Z');
    expect(renderSummary(j, false)).toMatch(/Contract frozen at .* after the session's last edit at 2026-09-28 18:24/);
    expect(j.assurance!.task.frozen_after_work).toBeTruthy();
  });
});

describe('command-line hygiene', () => {
  it('tally task with a path that does not exist is an error, not an inferred task', () => {
    const env = { ...process.env, TALLY_HOME: iso.home, CLAUDE_CONFIG_DIR: iso.claude, TALLY_LLM: 'stub' };
    const { cwd, base } = repoEditedByShell();
    seedSession('live-task-1', cwd, base);
    const r = spawnSync(process.execPath, [CLI, 'task', 'tasks\\readme-windows.md', '--session', 'live-task-1'], { cwd: iso.home, encoding: 'utf8', env });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/File not found: .*readme-windows\.md/);
    expect(fs.existsSync(path.join(sessionDir('live-task-1'), 'task.json'))).toBe(false);
  });

  it('tally verify --help prints only verify', () => {
    const r = spawnSync(process.execPath, [CLI, 'verify', '--help'], { encoding: 'utf8', env: { ...process.env, TALLY_HOME: iso.home } });
    expect(r.stdout).toMatch(/^Usage:\n  verify /);
    expect(r.stdout).not.toContain('tally task');
    expect(r.stdout.split('\n').filter(Boolean).length).toBeLessThan(6);
  });

  it('sessionCwd falls back to the frozen task when no events name a directory', () => {
    ensureDir(sessionDir('cwd-1'));
    fs.writeFileSync(path.join(sessionDir('cwd-1'), 'task.json'), JSON.stringify({ cwd: 'C:/some/repo' }));
    expect(sessionCwd('cwd-1')).toBe('C:/some/repo');
  });
});
