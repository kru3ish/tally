import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isolate, tmpDir, root } from './helpers.js';
import { EvalTaskSchema, loadTasks } from '../src/eval/tasks.js';
import { writeResult, readLedger, aggregate, type EvalRunResult } from '../src/eval/ledger.js';
import { graderPrompt, parseGraderJson } from '../src/eval/grader.js';
import { scoreIssue } from '../src/eval/discover.js';
import { prepareRepo, writeHookSettings, runEvalTask } from '../src/eval/run.js';
import { readCalibration } from '../src/calibrate/calibrate.js';

const HOOK = path.join(root, 'dist', 'hook.js');

let iso: ReturnType<typeof isolate>;
let cwd0: string;
beforeEach(() => {
  iso = isolate();
  cwd0 = process.cwd();
  process.env.TALLY_LLM = 'stub';
});
afterEach(() => {
  process.chdir(cwd0);
  delete process.env.TALLY_LLM;
  iso.restore();
});

function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_EMAIL: 't@t', GIT_AUTHOR_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_COMMITTER_NAME: 't' } });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

function sourceRepo(): string {
  const cwd = tmpDir('tally-eval-src-');
  git(cwd, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node test.js' } }));
  fs.writeFileSync(path.join(cwd, 'src.js'), 'module.exports = () => 200;\n');
  fs.writeFileSync(path.join(cwd, 'test.js'), "if (require('./src.js')() !== 200) process.exit(1); console.log('1 passing');\n");
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '-m', 'base']);
  return cwd;
}

const baseResult = (over: Partial<EvalRunResult> = {}): EvalRunResult => ({
  schema: 'tally.eval.v1',
  run_id: 'abc123',
  date: '2026-09-27T10:00:00.000Z',
  tally: { version: '0.5.0', commit: 'deadbee' },
  task: { id: 't1', class: 'fixture', repo: 'x', base: 'b', head: 'h', tags: [], contamination: 'unlikely' },
  agent: { product: 'claude-code', model: 'claude-sonnet-5', turns: 5, duration_s: 30, cost_usd: 0.2 },
  grader: { product: 'claude-code', model: 'claude-opus-5', cost_usd: 0.3, blind: true },
  session: 's1',
  tally_summary: { verified: 1, supported: 1, unverified: 0, unmet: 1, total: 3, verdict: 'borderline', completion_pct: 66.7 },
  grader_verdict: 'borderline',
  tests: { independent_ran: true, independent_passed: true, total_passed: 3, preexisting_files: 1, agent_added_files: 1, agent_cases_added: 2 },
  criteria: [],
  agreement: { exact: 2, total: 3, false_verified: 1, false_unmet: 0, verified_vs_supported: 2 },
  timings: {},
  notes: [],
  ...over,
});

describe('eval task specs', () => {
  it('validates a spec and resolves local repos and task files relative to the spec', () => {
    const dir = tmpDir('tally-eval-specs-');
    fs.mkdirSync(path.join(dir, 'eval', 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'eval', 'tasks', 'one.json'), JSON.stringify({ id: 'one', class: 'fixture', repo: '../../repo', task: 'Do the thing', selected_because: 'test', added: '2026-09-27' }));
    fs.writeFileSync(path.join(dir, 'eval', 'tasks', 'two.json'), JSON.stringify({ id: 'two', class: 'real', repo: 'https://github.com/a/b.git', base: 'abc', task: 'two.md', selected_because: 'test', added: '2026-09-27', contamination: 'likely' }));
    fs.writeFileSync(path.join(dir, 'eval', 'tasks', 'two.md'), '# Task two\n');
    const tasks = loadTasks(path.join(dir, 'eval', 'tasks'));
    expect(tasks.map((t) => t.id)).toEqual(['one', 'two']);
    expect(tasks[0]!.repoPath).toBe(path.resolve(dir, 'eval', 'tasks', '../../repo'));
    expect(tasks[0]!.taskText).toBe('Do the thing');
    expect(tasks[1]!.repoPath).toBeUndefined();
    expect(tasks[1]!.taskText).toBe('# Task two\n');
    expect(() => EvalTaskSchema.parse({ id: 'Bad Id', class: 'real', repo: 'x', task: 't', selected_because: 's', added: 'd' })).toThrow();
  });
});

describe('eval ledger', () => {
  it('writes a public-safe result file and a ledger line, and aggregates by class and version', () => {
    const dir = tmpDir('tally-eval-ledger-');
    writeResult(baseResult(), dir);
    writeResult(baseResult({ run_id: 'def456', task: { id: 't2', class: 'real', repo: 'y', base: 'b', head: 'h', tags: [], contamination: 'possible' }, agreement: { exact: 5, total: 5, false_verified: 0, false_unmet: 0, verified_vs_supported: 5 }, grader_verdict: 'worth it', tally_summary: { verified: 5, supported: 0, unverified: 0, unmet: 0, total: 5, verdict: 'worth it', completion_pct: 100 } }), dir);
    const files = fs.readdirSync(path.join(dir, 'eval', 'results', 'fixture'));
    expect(files).toEqual(['2026-09-27-t1-abc123.json']);
    const lines = readLedger(dir);
    expect(lines.length).toBe(2);
    const agg = aggregate(lines);
    expect(agg.map((a) => a.class)).toEqual(['fixture', 'real']);
    expect(agg[0]).toMatchObject({ runs: 1, criteria: 3, exact: 2, false_verified: 1, verdict_agreement: 1, verdict_n: 1 });
    expect(agg[1]).toMatchObject({ runs: 1, criteria: 5, exact: 5, false_verified: 0 });
    const text = fs.readFileSync(path.join(dir, 'eval', 'results', 'fixture', files[0]!), 'utf8');
    expect(text).not.toMatch(/transcript|prompt_text/);
  });
});

describe('blind grader', () => {
  it('builds a prompt with the task, criteria, repo, base and test command, and none of Tally\'s answers', () => {
    const p = graderPrompt({ taskText: '# Fix it', criteria: [{ id: 'c1', text: 'Returns 429' }], repoPath: 'C:/r', base: 'abc', testCommand: 'npm test', agentCost: 1.5, agentTurns: 12 });
    expect(p).toContain('# Fix it');
    expect(p).toContain('- c1: Returns 429');
    expect(p).toContain('Base commit');
    expect(p).not.toMatch(/VERIFIED|SUPPORTED|verdict.*worth it.*Tally said/);
  });

  it('parses fenced, bare and slightly malformed JSON and normalises statuses', () => {
    const j = parseGraderJson('Here you go: {"criteria":[{"id":"c1","status":"met","evidence":"x"},{"id":"c2","status":"bogus","evidence":"y"}],"verdict":"worth it","quality_note":"fine"}')!;
    expect(j.criteria.map((c) => c.status)).toEqual(['met', 'unverifiable']);
    expect(j.verdict).toBe('worth it');
    expect(parseGraderJson('no json')).toBeNull();
  });
});

describe('discovery scoring', () => {
  it('prefers reproducible, scoped bugs with tests and penalises infrastructure and discussions', () => {
    const good = scoreIssue({ number: 1, title: 'parse() drops quoted commas', body: 'Steps:\n```js\nparse(\'"a,b",c\')\n```\nExpected two cells, got three.' + 'x'.repeat(200), html_url: '', comments: 2, updated_at: '', labels: [{ name: 'bug' }] }, { tests: true });
    const bad = scoreIssue({ number: 2, title: 'RFC: redesign the plugin system', body: 'We should discuss moving to kubernetes and aws.', html_url: '', comments: 40, updated_at: '', labels: [] }, { tests: false });
    expect(good.score).toBeGreaterThan(bad.score);
    expect(good.reasons.join(' ')).toMatch(/code block/);
    expect(bad.reasons.join(' ')).toMatch(/infrastructure|discussion/);
  });
});

describe('eval run', () => {
  it('prepares an isolated copy at the base with task.md and the policy committed, and writes hook settings', () => {
    const src = sourceRepo();
    const dir = path.join(tmpDir('tally-eval-run-'), 'one');
    const { base } = prepareRepo({ id: 'one', class: 'fixture', repo: src, repoPath: src, task: 'Make it 429', taskText: 'Make it 429', criteria: [{ text: 'src.js returns 429' }], test_command: 'node test.js', setup: [], tags: [], selected_because: 't', contamination: 'unlikely', added: '2026-09-27' }, dir, () => {});
    expect(fs.existsSync(path.join(dir, 'task.md'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'task.md'), 'utf8')).toContain('- src.js returns 429');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'tally.json'), 'utf8')).test_command).toBe('node test.js');
    expect(git(dir, ['log', '--format=%s', '-1'])).toBe('eval: task contract');
    expect(base).toBe(git(dir, ['rev-parse', 'HEAD']));
    const settings = JSON.parse(fs.readFileSync(writeHookSettings(path.dirname(dir)), 'utf8')) as { hooks: Record<string, unknown> };
    expect(Object.keys(settings.hooks)).toContain('Stop');
    expect(JSON.stringify(settings)).toContain('hook.js');
  });

  it('runs the whole loop with an injected agent and grader, records the result, the ledger and a blind-eval calibration entry', async () => {
    const src = sourceRepo();
    const work = tmpDir('tally-eval-root-');
    process.chdir(work);
    /* a fake agent: drives Tally's real hook with a scripted session, edits the repo, commits */
    const agent = async ({ cwd, settingsFile }: { cwd: string; settingsFile: string }) => {
      const session = 'eval-fake-' + Date.now().toString(36);
      const hook = (event: string, input: Record<string, unknown>) => spawnSync(process.execPath, [HOOK, event], { input: JSON.stringify({ session_id: session, cwd, ...input }), encoding: 'utf8', env: { ...process.env, TALLY_NO_SPAWN: '1' } });
      expect(fs.existsSync(settingsFile)).toBe(true);
      hook('SessionStart', { source: 'startup' });
      hook('UserPromptSubmit', { prompt: 'Implement the task described in task.md' });
      hook('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: path.join(cwd, 'src.js') }, tool_use_id: 't1' });
      fs.writeFileSync(path.join(cwd, 'src.js'), 'module.exports = () => 429;\n');
      fs.writeFileSync(path.join(cwd, 'test.js'), "if (require('./src.js')() !== 429) process.exit(1); console.log('1 passing');\n");
      hook('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: path.join(cwd, 'src.js') }, tool_use_id: 't1', tool_response: 'ok' });
      hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'node test.js' }, tool_use_id: 't2' });
      hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'node test.js' }, tool_use_id: 't2', tool_response: '1 passing' });
      git(cwd, ['add', '-A']);
      git(cwd, ['commit', '-q', '-m', 'agent: return 429']);
      hook('Stop', { last_assistant_message: 'Done.' });
      hook('SessionEnd', { reason: 'exit' });
      return { sessionId: session, costUsd: null, turns: 4, durationS: 1 };
    };
    const grader = () => ({ criteria: [{ id: 'c1', status: 'met' as const, evidence: 'src.js returns 429 and the test asserts it' }], verdict: 'worth it' as const, quality_note: 'fine', model: 'fake-grader', cost_usd: 0, duration_s: 0 });
    const r = await runEvalTask({ task: { id: 'one', class: 'fixture', repo: src, repoPath: src, task: 'Make src.js return 429 and update the test', taskText: 'Make src.js return 429 and update the test', criteria: [{ text: 'src.js returns 429', check: { kind: 'file_contains', path: 'src.js', pattern: '429' } }], test_command: 'node test.js', setup: [], tags: ['constructed'], selected_because: 'test', contamination: 'unlikely', added: '2026-09-27' }, agent, grader, root: path.join(work, 'tmp'), out: () => {} });
    expect(r.schema).toBe('tally.eval.v1');
    expect(r.agent.product).toBe('claude-code');
    expect(r.agent.cost_usd).toBeNull();
    expect(r.grader.blind).toBe(true);
    expect(r.criteria.length).toBeGreaterThan(0);
    expect(r.agreement.total).toBe(r.criteria.length);
    expect(r.agreement.false_verified).toBe(0);
    expect(r.tests.independent_ran).toBe(true);
    const ledger = readLedger(work);
    expect(ledger.length).toBe(1);
    expect(ledger[0]!.task.class).toBe('fixture');
    expect(fs.existsSync(path.join(work, ledger[0]!.file))).toBe(true);
    const cal = readCalibration().filter((e) => e.grader === 'blind-eval');
    expect(cal.length).toBe(1);
    expect(cal[0]!.criteria[0]!.assurance).toBeDefined();
  });
});

describe('resume', () => {
  it('continues from an existing worktree and session without running the agent again', async () => {
    const work = tmpDir('tally-eval-resume-');
    const srcRepo = path.join(work, 'src');
    fs.mkdirSync(srcRepo);
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: srcRepo });
    fs.writeFileSync(path.join(srcRepo, 'package.json'), JSON.stringify({ name: 'r', scripts: { test: 'node -e "console.log(\'1 passing\')"' } }));
    fs.writeFileSync(path.join(srcRepo, 'README.md'), '# r\n');
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], { cwd: srcRepo });
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base'], { cwd: srcRepo });
    const task = { id: 'resume-task', class: 'fixture' as const, repo: srcRepo, task: 'Add a greeting to the README', criteria: [{ text: 'README mentions hello', check: { kind: 'file_contains', path: 'README.md', pattern: 'hello' } }], setup: [], tags: [], selected_because: 't', contamination: 'unlikely' as const, added: '2026-09-27', file: 'x', repoPath: srcRepo, taskText: 'Add a greeting to the README' };
    const root = tmpDir('tally-eval-resume-root-');
    const dir = path.join(root, task.id);
    const { base } = prepareRepo(task, dir, () => {});
    /* the "agent" already worked and its session exists: a README edit committed, and a receipt for that session */
    fs.appendFileSync(path.join(dir, 'README.md'), 'hello\n');
    spawnSync('git', ['-c', 'user.email=a@a', '-c', 'user.name=a', 'commit', '-q', '-am', 'greet'], { cwd: dir });
    const session = 'resume-session-1';
    let agentCalls = 0;
    const r = await runEvalTask({
      task,
      resume: { root, session },
      agent: async () => {
        agentCalls += 1;
        return { sessionId: session, costUsd: 0, turns: 0, durationS: 0 };
      },
      grader: () => ({ criteria: [{ id: 'c1', status: 'met', evidence: 'README says hello' }], verdict: 'worth it', quality_note: '', duration_s: 1 }),
      out: () => {},
    });
    expect(agentCalls).toBe(0);
    expect(r.task.base).toBe(base);
    expect(r.session).toBe(session);
    expect(r.notes.some((n) => /resumed from/.test(n))).toBe(true);
    expect(r.work?.commits.some((c) => /greet/.test(c))).toBe(true);
    expect(r.agreement.total).toBe(1);
  });
});
