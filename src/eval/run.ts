/* `tally eval run`: the autonomous evaluation loop for one task.

     1. prepare an isolated repository (clone at the base commit, or copy a local fixture), run its setup, freeze the task
        text and the Tally policy into it, and commit that as the base
     2. run a coding-agent session against the task with Tally's hooks attached through --settings, so the run does
        not depend on what the user has installed
     3. let Tally judge the session (intake, independent test run, Evidence Map)
     4. start the blind evaluator in a separate process with fresh context and only the task, repository, base and tests
     5. compare, record disagreements and the two errors that matter (false VERIFIED, false UNMET), write the ledger,
        and add the grade to calibration.jsonl so `tally calibrate report` sees it

   Everything the run touched is under a temp root the caller can keep (--keep) or that is removed at the end. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { loadConfig, setTestRerunConsent } from '../config.js';
import { makeLlm } from '../llm/client.js';
import { intake, loadTask } from '../task/intake.js';
import { judgeSession, loadJudge } from '../judge/judge.js';
import { readEvents } from '../store/events.js';
import { builtHookPath, sessionDir, ensureDir, log, tallyHome, appendLine, packageRoot, readJson } from '../paths.js';
import { calibrationFile, entryFromJudge } from '../calibrate/calibrate.js';
import { buildAssurance, type Assurance } from '../assurance/index.js';
import { runClaudeGrader, type GraderInput, type GraderOutput } from './grader.js';
import { writeResult, resultsRoot, type EvalRunResult, type CriterionResult } from './ledger.js';
import type { EvalTask } from './tasks.js';

export interface AgentRunner {
  (opts: { cwd: string; prompt: string; settingsFile: string; model: string; maxTurns: number; timeoutMs: number }): Promise<{ sessionId: string | null; costUsd: number | null; turns: number | null; durationS: number; error?: string }>;
}

export interface RunOptions {
  task: EvalTask & { repoPath?: string; taskText: string };
  root?: string;
  agentModel?: string;
  graderModel?: string;
  maxTurns?: number;
  timeoutMin?: number;
  keep?: boolean;
  /* how long to wait for the receipt the SessionEnd hook produces before judging in the runner (0 = judge at once) */
  hookJudgeWaitMs?: number;
  out?: (s: string) => void;
  /* injectable for tests */
  agent?: AgentRunner;
  grader?: (input: GraderInput) => GraderOutput;
  claudeBin?: string;
}

const AGENT_TOOLS = ['Bash(npm test*)', 'Bash(npm run*)', 'Bash(npx *)', 'Bash(node *)', 'Bash(git *)', 'Bash(ls*)', 'Bash(cat *)', 'Bash(grep *)', 'Bash(mkdir *)', 'Bash(python*)', 'Bash(pytest*)', 'Bash(go *)', 'Bash(cargo *)', 'Read', 'Edit', 'Write', 'MultiEdit', 'Glob', 'Grep', 'TodoWrite'];

/* never through a shell: arguments with spaces (commit messages, paths) must arrive intact; setup commands get cmd.exe / sh explicitly */
function sh(cwd: string, cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env, windowsHide: true, shell: false, maxBuffer: 50 * 1024 * 1024, timeout: 15 * 60 * 1000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}` };
}

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'tally-eval', GIT_AUTHOR_EMAIL: 'eval@tally.local', GIT_COMMITTER_NAME: 'tally-eval', GIT_COMMITTER_EMAIL: 'eval@tally.local' };

/* Clone or copy, check out the base, run setup, write task.md and tally.json, commit. Returns the base the agent starts from. */
export function prepareRepo(task: RunOptions['task'], dir: string, out: (s: string) => void): { base: string; setupLog: string } {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  if (task.repoPath) {
    fs.cpSync(task.repoPath, dir, { recursive: true, filter: (src) => !/[\\/]node_modules[\\/]?$/.test(src) || true });
    if (task.base) sh(dir, 'git', ['checkout', '-q', task.base], GIT_ENV);
  } else {
    const r = sh(path.dirname(dir), 'git', ['clone', '-q', task.repo, dir], GIT_ENV);
    if (!r.ok) throw new Error(`clone failed: ${r.out.slice(0, 300)}`);
    if (task.base) {
      const c = sh(dir, 'git', ['checkout', '-q', task.base], GIT_ENV);
      if (!c.ok) throw new Error(`checkout ${task.base} failed: ${c.out.slice(0, 300)}`);
    }
  }
  let setupLog = '';
  for (const cmd of task.setup) {
    out(`  setup: ${cmd}`);
    const r = sh(dir, process.platform === 'win32' ? 'cmd.exe' : 'sh', process.platform === 'win32' ? ['/d', '/s', '/c', cmd] : ['-c', cmd]);
    setupLog += `$ ${cmd}\n${r.out.slice(-1500)}\n`;
    if (!r.ok) throw new Error(`setup failed: ${cmd}\n${r.out.slice(-500)}`);
  }
  const md = task.criteria?.length ? `${task.taskText.trim()}\n\n## Acceptance criteria\n\n${task.criteria.map((c) => `- ${c.text}`).join('\n')}\n` : task.taskText;
  fs.writeFileSync(path.join(dir, 'task.md'), md);
  if (task.test_command) fs.writeFileSync(path.join(dir, 'tally.json'), JSON.stringify({ test_command: task.test_command, note: 'written by tally eval' }, null, 2) + '\n');
  sh(dir, 'git', ['add', 'task.md', ...(task.test_command ? ['tally.json'] : [])], GIT_ENV);
  /* a local corpus repo may already hold this exact task.md at the base: then there is nothing to commit and HEAD is the base */
  const staged = sh(dir, 'git', ['diff', '--cached', '--quiet'], GIT_ENV);
  if (!staged.ok) {
    const commit = sh(dir, 'git', ['commit', '-q', '--no-verify', '-m', 'eval: task contract'], GIT_ENV);
    if (!commit.ok) throw new Error(`could not commit the task contract: ${commit.out.slice(0, 300)}`);
  }
  const base = sh(dir, 'git', ['rev-parse', 'HEAD'], GIT_ENV).out.trim();
  return { base, setupLog };
}

/* Tally's hooks as a settings file passed with --settings, independent of the user's installation. */
export function writeHookSettings(dir: string): string {
  const hook = builtHookPath();
  const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'PreCompact', 'SessionEnd'];
  const hooks = Object.fromEntries(events.map((e) => [e, [{ hooks: [{ type: 'command', command: `node "${hook}" ${e}`, timeout: 5 }] }]]));
  const file = path.join(dir, 'tally-eval-settings.json');
  fs.writeFileSync(file, JSON.stringify({ hooks }, null, 2));
  return file;
}

export const claudeAgent: (bin?: string) => AgentRunner = (bin) => async ({ cwd, prompt, settingsFile, model, maxTurns, timeoutMs }) => {
  const started = Date.now();
  const exe = bin ?? process.env.CLAUDE_BIN ?? 'claude';
  const args = ['-p', prompt, '--model', model, '--permission-mode', 'acceptEdits', '--max-turns', String(maxTurns), '--output-format', 'json', '--strict-mcp-config', '--settings', settingsFile, '--allowedTools', ...AGENT_TOOLS];
  return new Promise((resolve) => {
    const child = spawn(exe, args, { cwd, env: { ...process.env }, windowsHide: true, shell: false });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('close', () => {
      clearTimeout(timer);
      let j: { session_id?: string; total_cost_usd?: number; num_turns?: number; is_error?: boolean; result?: string } = {};
      try {
        j = JSON.parse(out);
      } catch {
        j = {};
      }
      resolve({ sessionId: j.session_id ?? null, costUsd: j.total_cost_usd ?? null, turns: j.num_turns ?? null, durationS: Math.round((Date.now() - started) / 1000), error: j.session_id ? undefined : `agent produced no session (exit output: ${(err || out).slice(-300)})` });
    });
    child.on('error', (e) => resolve({ sessionId: null, costUsd: null, turns: null, durationS: Math.round((Date.now() - started) / 1000), error: String(e) }));
  });
};

const AGENT_PROMPT = 'Implement the task described in task.md in this repository. Read task.md first. Reproduce the problem if it is a bug, make the change, add or update tests in the existing suite, run the test suite before you finish (if tally.json names a test_command, use that), and commit your work with a clear message. Do not modify task.md or tally.json, and do not push or open pull requests.';

function compare(assurance: Assurance, grader: GraderOutput): { criteria: CriterionResult[]; agreement: EvalRunResult['agreement'] } {
  const byId = new Map(grader.criteria.map((c) => [c.id, c]));
  const criteria: CriterionResult[] = assurance.criteria.map((c) => {
    const g = byId.get(c.id) ?? { id: c.id, status: 'unverifiable' as const, evidence: 'grader gave no answer for this criterion' };
    const agree = g.status === c.judge_status;
    const false_verified = c.status === 'VERIFIED' && (g.status === 'unmet' || g.status === 'partial');
    const false_unmet = c.status === 'UNMET' && g.status === 'met';
    return { id: c.id, text: c.text, tally: { status: c.judge_status, assurance: c.status, resolved_by: c.resolved_by, evidence: c.evidence.map((e) => `${e.strength === 'interpreted' ? '[model] ' : ''}${e.summary}`).slice(0, 8) }, grader: { status: g.status, evidence: g.evidence }, agree, false_verified, false_unmet };
  });
  return {
    criteria,
    agreement: {
      exact: criteria.filter((c) => c.agree).length,
      total: criteria.length,
      false_verified: criteria.filter((c) => c.false_verified).length,
      false_unmet: criteria.filter((c) => c.false_unmet).length,
      verified_vs_supported: criteria.filter((c) => (c.tally.assurance === 'VERIFIED' || c.tally.assurance === 'SUPPORTED') && c.grader.status === 'met').length,
    },
  };
}

export async function runEvalTask(opts: RunOptions): Promise<EvalRunResult> {
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const cfg = loadConfig();
  const runId = Math.random().toString(36).slice(2, 8);
  const root = opts.root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'tally-eval-'));
  const dir = path.join(root, opts.task.id);
  const notes: string[] = [];
  const version = readJson<{ version?: string }>(path.join(packageRoot(), 'package.json'), {}).version ?? '0.0.0';
  const commit = sh(packageRoot(), 'git', ['rev-parse', '--short', 'HEAD']).out.trim() || undefined;

  out(`[${opts.task.id}] preparing ${opts.task.repo}${opts.task.base ? ' @ ' + opts.task.base.slice(0, 8) : ''}`);
  const { base } = prepareRepo(opts.task, dir, out);
  setTestRerunConsent(dir, true);
  const settingsFile = writeHookSettings(root);

  out(`[${opts.task.id}] agent session (${opts.agentModel ?? 'sonnet'}, ≤${opts.maxTurns ?? 80} turns)`);
  const agent = opts.agent ?? claudeAgent(opts.claudeBin);
  const a = await agent({ cwd: dir, prompt: AGENT_PROMPT, settingsFile, model: opts.agentModel ?? 'sonnet', maxTurns: opts.maxTurns ?? 80, timeoutMs: (opts.timeoutMin ?? 45) * 60 * 1000 });
  if (a.error) notes.push(a.error);
  if (!a.sessionId) throw new Error(`no agent session for ${opts.task.id}: ${a.error ?? 'unknown'}`);
  const session = a.sessionId;
  const head = sh(dir, 'git', ['rev-parse', 'HEAD']).out.trim();
  out(`[${opts.task.id}] session ${session.slice(0, 8)}: ${a.turns ?? '?'} turns, ${a.durationS}s${a.costUsd != null ? `, $${a.costUsd.toFixed(2)}` : ''}`);

  /* Tally's side: make sure the contract exists (intake may still be running from the hook), then judge */
  const t0 = Date.now();
  if (!loadTask(session)) {
    out(`[${opts.task.id}] intake`);
    await intake({ session, cwd: dir, ref: path.join(dir, 'task.md'), cfg, llm: makeLlm({ session }) });
  }
  /* The SessionEnd hook already spawned Tally's own finalize/judge for this session. That receipt is the one a user would
     get, so wait for it rather than judging a second time: two receipts for one session cost twice and, because the
     maintainer review is a model read, can disagree with each other (yargs-2423: borderline from the runner's judge,
     worth it from the hook's, thirty seconds apart). A fake agent (tests) triggers no hooks, so there is nothing to wait for. */
  const waitMs = opts.hookJudgeWaitMs ?? (opts.agent ? 0 : 10 * 60 * 1000);
  const hookJudged = (): boolean => {
    const j = loadJudge(session);
    return !!j && j.head === head && j.reason === 'session_end';
  };
  if (waitMs > 0 && !hookJudged()) {
    out(`[${opts.task.id}] waiting for the session-end judge started by the hook (up to ${Math.round(waitMs / 60000)} min)`);
    const until = Date.now() + waitMs;
    while (Date.now() < until && !hookJudged()) await new Promise((r) => setTimeout(r, 5000));
  }
  const events = readEvents(session);
  const transcriptPath = events.find((e) => typeof e.data.transcript_path === 'string')?.data.transcript_path as string | undefined;
  let judge = loadJudge(session);
  if (judge && judge.head === head) notes.push(`receipt from the ${judge.reason === 'session_end' ? 'session-end hook' : judge.reason + ' judge'}; the runner did not judge again`);
  if (!judge || judge.head !== head) {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) notes.push('no transcript found for the session; cost and turns come from the agent envelope only');
    if (waitMs > 0) notes.push(`the hook's session-end judge did not produce a receipt within ${Math.round(waitMs / 60000)} min; the runner judged`);
    out(`[${opts.task.id}] judge`);
    judge = await judgeSession({ session, cwd: dir, transcriptPath: transcriptPath ?? path.join(sessionDir(session), 'missing.jsonl'), cfg, llm: makeLlm({ session }), reason: 'manual', consent: true, events });
  }
  const assurance = judge.assurance ?? buildAssurance({ judge, task: loadTask(session), cwd: dir });
  const judgeS = Math.round((Date.now() - t0) / 1000);

  /* the blind evaluator: fresh process, no Tally output */
  out(`[${opts.task.id}] blind evaluator (${opts.graderModel ?? 'opus'})`);
  const t1 = Date.now();
  const graderInput: GraderInput = { taskText: fs.readFileSync(path.join(dir, 'task.md'), 'utf8'), criteria: judge.criteria.map((c) => ({ id: c.id, text: c.text })), repoPath: dir, base, testCommand: opts.task.test_command ?? judge.verification.command ?? 'npm test', agentCost: a.costUsd, agentTurns: a.turns };
  const g = opts.grader ? opts.grader(graderInput) : runClaudeGrader(graderInput, { model: opts.graderModel, bin: opts.claudeBin });
  if (g.raw_error) notes.push(g.raw_error);
  const graderS = Math.round((Date.now() - t1) / 1000);

  const { criteria, agreement } = compare(assurance, g);
  /* preserve the agent's work: commits, per-file counts, and the patch itself next to the result (capped) */
  const commits = sh(dir, 'git', ['log', '--format=%h %s', `${base}..${head}`]).out.trim().split('\n').filter(Boolean);
  const files = sh(dir, 'git', ['diff', '--numstat', base, head]).out.trim().split('\n').filter(Boolean).map((l) => { const [a, d, f] = l.split('\t'); return { file: f ?? '', added: Number(a) || 0, deleted: Number(d) || 0 }; });
  const patch = sh(dir, 'git', ['diff', base, head, '--', '.', ':(exclude)package-lock.json', ':(exclude)**/package-lock.json']).out;
  const patchBytes = Buffer.byteLength(patch, 'utf8');
  const resultsDir = path.join(resultsRoot(), opts.task.class);
  fs.mkdirSync(resultsDir, { recursive: true });
  const patchFile = patchBytes > 0 && patchBytes <= 400 * 1024 ? path.join(resultsDir, `${new Date().toISOString().slice(0, 10)}-${opts.task.id}-${runId}.patch`) : undefined;
  if (patchFile) fs.writeFileSync(patchFile, patch);
  else if (patchBytes > 400 * 1024) notes.push(`patch not stored: ${patchBytes} bytes exceeds the 400 KB cap; commits and per-file counts are recorded`);
  const result: EvalRunResult = {
    schema: 'tally.eval.v1',
    run_id: runId,
    date: new Date().toISOString(),
    tally: { version, commit },
    task: { id: opts.task.id, class: opts.task.class, repo: opts.task.repo, base, head, issue: opts.task.issue, tags: opts.task.tags, contamination: opts.task.contamination, human_fix: opts.task.human_fix },
    agent: { product: assurance.agent.product, model: assurance.model?.model, turns: a.turns ?? undefined, duration_s: a.durationS, cost_usd: a.costUsd },
    config: { agent_model: opts.agentModel ?? 'sonnet', max_turns: opts.maxTurns ?? 80, timeout_min: opts.timeoutMin ?? 45, permission_mode: 'acceptEdits', allowed_tools: [...AGENT_TOOLS], grader_model: opts.graderModel ?? 'opus' },
    work: { commits, files, patch_file: patchFile, patch_bytes: patchBytes },
    grader: { product: 'claude-code', model: g.model, cost_usd: g.cost_usd ?? null, blind: true },
    session,
    tally_summary: { ...assurance.summary, verdict: judge.verdict.verdict, completion_pct: judge.completion_pct },
    grader_verdict: g.criteria.length ? g.verdict : undefined,
    tests: { independent_ran: assurance.verification.independent.ran, independent_passed: assurance.verification.independent.passed, total_passed: assurance.verification.independent.total_passed, preexisting_files: assurance.verification.preexisting_files, agent_added_files: assurance.verification.agent_created.added_files.length, agent_cases_added: assurance.verification.agent_created.cases_added },
    criteria,
    agreement,
    timings: { agent_s: a.durationS, judge_s: judgeS, grader_s: graderS },
    notes,
  };
  const file = writeResult(result);
  /* the grade also lands in calibration.jsonl, so the existing report and rescore tooling see it */
  if (g.criteria.length === judge.criteria.length) {
    const entry = entryFromJudge(judge, judge.criteria.map((c) => g.criteria.find((x) => x.id === c.id)?.status ?? 'unverifiable'), g.verdict, 'backfill');
    ensureDir(tallyHome());
    appendLine(calibrationFile(), JSON.stringify({ ...entry, grader: 'blind-eval' }));
  }
  out(`[${opts.task.id}] ${agreement.exact}/${agreement.total} agree · false VERIFIED ${agreement.false_verified} · false UNMET ${agreement.false_unmet} · Tally ${judge.verdict.verdict} / grader ${g.verdict} → ${path.relative(process.cwd(), file)}`);
  if (!opts.keep && !opts.root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  else log(`eval: kept ${root}`);
  return result;
}
