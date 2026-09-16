/* Reconstructs what a past session changed: the start HEAD (last commit before the session on its branch), the end
   HEAD (last commit inside the window, extended to the merged PR head), a detached worktree at the end HEAD, and
   a historical test run inside it. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runProcess } from '../llm/client.js';
import { detectTestCommand, scrubEnv, type VerificationResult } from '../judge/verify.js';
import { ghStatus } from '../followup/gh.js';

export type Exec = (bin: string, args: string[], cwd: string) => { ok: boolean; stdout: string; stderr: string };

export const gitExecRaw: Exec = (bin, args, cwd) => {
  const r = spawnSync(bin, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 20 * 1024 * 1024 });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

export interface Window {
  start_head?: string;
  end_head?: string;
  branch?: string;
  commits_in_window: number;
  extended_to_pr?: string;
  notes: string[];
}

export const HISTORICAL_UNRUNNABLE = 'historical tests not runnable';
/* git's well-known empty tree object; a valid diff base for a repo or branch born inside the session */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function revBefore(cwd: string, ref: string, ts: string, exec: Exec): string | undefined {
  const r = exec('git', ['rev-list', '-1', `--before=${ts}`, ref], cwd);
  return r.ok ? r.stdout.trim() || undefined : undefined;
}

export function reconstructWindow(cwd: string, opts: { branch?: string; start: string; end: string; exec?: Exec; ghOk?: boolean }): Window {
  const exec = opts.exec ?? gitExecRaw;
  const notes: string[] = [];
  let branch = opts.branch;
  if (branch) {
    const ok = exec('git', ['rev-parse', '--verify', '--quiet', branch], cwd).ok;
    if (!ok) {
      notes.push(`branch "${branch}" no longer exists; using all refs`);
      branch = undefined;
    }
  }
  const ref = branch ?? '--all';
  let start_head = revBefore(cwd, ref, opts.start, exec);
  let end_head = revBefore(cwd, ref, opts.end, exec);
  const count = exec('git', ['rev-list', '--count', `--since=${opts.start}`, `--until=${opts.end}`, ref], cwd);
  const commits_in_window = count.ok ? Number(count.stdout.trim()) || 0 : 0;
  if (!start_head && commits_in_window > 0) {
    /* the branch (or repo) was created during the session: diff from the empty tree so every file counts as added */
    start_head = EMPTY_TREE;
    notes.push('no commit before the session start on this branch; diffing from the empty tree');
  } else if (!start_head) notes.push('no commit before the session start on this branch');
  if (commits_in_window === 0) notes.push('no commits inside the session window; uncommitted work cannot be recovered');
  let extended_to_pr: string | undefined;
  if (branch && (opts.ghOk ?? ghStatus().ok) && branch !== 'main' && branch !== 'master') {
    const r = exec('gh', ['pr', 'list', '--state', 'merged', '--head', branch, '--json', 'headRefOid,number', '--limit', '1'], cwd);
    if (r.ok) {
      try {
        const [pr] = JSON.parse(r.stdout) as Array<{ headRefOid: string; number: number }>;
        if (pr?.headRefOid && exec('git', ['cat-file', '-e', `${pr.headRefOid}^{commit}`], cwd).ok) {
          end_head = pr.headRefOid;
          extended_to_pr = `#${pr.number}`;
          notes.push(`end extended to merged PR #${pr.number} head ${pr.headRefOid.slice(0, 8)}`);
        }
      } catch {
        /* ignore */
      }
    }
  }
  return { start_head, end_head, branch, commits_in_window, extended_to_pr, notes };
}

export interface Worktree {
  path: string;
  remove: () => void;
}

export function addWorktree(cwd: string, sha: string, exec: Exec = gitExecRaw): Worktree {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-wt-'));
  fs.rmdirSync(dir);
  const r = exec('git', ['worktree', 'add', '--detach', dir, sha], cwd);
  if (!r.ok) throw new Error(`git worktree add failed: ${r.stderr.trim().slice(0, 200)}`);
  return {
    path: dir,
    remove: () => {
      exec('git', ['worktree', 'remove', '--force', dir], cwd);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      exec('git', ['worktree', 'prune'], cwd);
    },
  };
}

/* Installs dependencies offline when a lockfile is present; anything that needs the network makes the tests unrunnable. */
export async function prepareDeps(wt: string, timeoutMs: number): Promise<{ ok: boolean; note: string }> {
  const has = (f: string) => fs.existsSync(path.join(wt, f));
  if (has('package.json')) {
    if (has('node_modules')) return { ok: true, note: 'node_modules present' };
    const pkg = JSON.parse(fs.readFileSync(path.join(wt, 'package.json'), 'utf8')) as { dependencies?: object; devDependencies?: object };
    if (!Object.keys(pkg.dependencies ?? {}).length && !Object.keys(pkg.devDependencies ?? {}).length) return { ok: true, note: 'no dependencies' };
    if (!has('package-lock.json') && !has('npm-shrinkwrap.json')) return { ok: false, note: 'no lockfile; offline install not attempted' };
    const isWin = process.platform === 'win32';
    const cmd = 'npm ci --offline --ignore-scripts --no-audit --no-fund';
    const r = await runProcess(isWin ? 'cmd.exe' : 'sh', isWin ? ['/d', '/s', '/c', `"${cmd}"`] : ['-c', cmd], { cwd: wt, timeoutMs, env: scrubEnv(), replaceEnv: true });
    return r.code === 0 ? { ok: true, note: 'npm ci --offline succeeded' } : { ok: false, note: `npm ci --offline failed (${r.timedOut ? 'timeout' : 'exit ' + r.code}); dependencies unavailable offline` };
  }
  if (has('requirements.txt') || has('pyproject.toml')) return { ok: fs.existsSync(path.join(wt, '.venv')) || fs.existsSync(path.join(wt, 'venv')), note: 'python: runs only when a checked-in venv exists' };
  return { ok: true, note: 'no dependency step needed' };
}

export async function runHistoricalTests(wt: string, opts: { consent?: boolean; timeoutMs: number }): Promise<VerificationResult> {
  if (opts.consent !== true) return { ran: false, reason: 'tests not run: no consent', consent: opts.consent };
  const detected = detectTestCommand(wt);
  if (!detected) return { ran: false, reason: 'no test command detected', consent: true };
  const deps = await prepareDeps(wt, opts.timeoutMs);
  if (!deps.ok) return { ran: false, reason: `${HISTORICAL_UNRUNNABLE}: ${deps.note}`, consent: true, command: detected.command };
  const started = Date.now();
  const isWin = process.platform === 'win32';
  const r = await runProcess(isWin ? 'cmd.exe' : 'sh', isWin ? ['/d', '/s', '/c', `"${detected.command}"`] : ['-c', detected.command], { cwd: wt, timeoutMs: opts.timeoutMs, env: scrubEnv(), replaceEnv: true });
  const out = (r.stdout + '\n' + r.stderr).trim();
  return { ran: true, command: detected.command, basis: `${detected.basis} (historical worktree; ${deps.note})`, passed: !r.timedOut && r.code === 0, exit_code: r.code, timed_out: r.timedOut, duration_ms: Date.now() - started, output_tail: out.length > 3000 ? '…' + out.slice(-3000) : out, env_scrubbed: true, consent: true };
}
