import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../llm/client.js';

export interface DetectedTest {
  command: string;
  basis: string;
}

export function detectTestCommand(cwd: string): DetectedTest | null {
  const pkg = path.join(cwd, 'package.json');
  if (fs.existsSync(pkg)) {
    try {
      const j = JSON.parse(fs.readFileSync(pkg, 'utf8')) as { scripts?: Record<string, string> };
      const t = j.scripts?.test;
      if (t && !/no test specified/i.test(t)) {
        const runner = fs.existsSync(path.join(cwd, 'bun.lockb')) || fs.existsSync(path.join(cwd, 'bun.lock')) ? 'bun test' : fs.existsSync(path.join(cwd, 'pnpm-lock.yaml')) ? 'pnpm test' : fs.existsSync(path.join(cwd, 'yarn.lock')) ? 'yarn test' : 'npm test';
        return { command: runner === 'bun test' ? 'bun run test' : runner, basis: 'package.json scripts.test' };
      }
    } catch {
      /* ignore */
    }
  }
  const has = (f: string) => fs.existsSync(path.join(cwd, f));
  if (has('pytest.ini') || has('conftest.py') || has('tests') && (has('pyproject.toml') || has('setup.py') || has('requirements.txt'))) return { command: 'python -m pytest -q', basis: 'pytest layout' };
  if (has('pyproject.toml')) {
    const p = fs.readFileSync(path.join(cwd, 'pyproject.toml'), 'utf8');
    if (/pytest/.test(p)) return { command: 'python -m pytest -q', basis: 'pyproject.toml mentions pytest' };
  }
  if (has('go.mod')) return { command: 'go test ./...', basis: 'go.mod' };
  if (has('Cargo.toml')) return { command: 'cargo test', basis: 'Cargo.toml' };
  if (has('Makefile') && /^test:/m.test(fs.readFileSync(path.join(cwd, 'Makefile'), 'utf8'))) return { command: 'make test', basis: 'Makefile test target' };
  if (has('mix.exs')) return { command: 'mix test', basis: 'mix.exs' };
  if (has('Gemfile') && has('spec')) return { command: 'bundle exec rspec', basis: 'Gemfile + spec/' };
  if (has('pom.xml')) return { command: 'mvn -q test', basis: 'pom.xml' };
  if (has('build.gradle') || has('build.gradle.kts')) return { command: 'gradle test', basis: 'gradle build file' };
  return null;
}

export interface VerificationResult {
  ran: boolean;
  command?: string;
  basis?: string;
  passed?: boolean;
  exit_code?: number | null;
  timed_out?: boolean;
  duration_ms?: number;
  output_tail?: string;
  reason?: string;
  env_scrubbed?: boolean;
  consent?: boolean;
  /* exit 0 but the runner ran nothing (a `test` script that only echoes, or no output at all): a pass that proves nothing */
  inconclusive?: boolean;
  /* what the runner's own summary line said, when one was found (mocha, node:test, tap, jest, pytest, go) */
  summary?: { passed: number | null; failed: number | null };
  /* the summary shows tests passing and none failing while the command exited non-zero: a later stage (lint, coverage
     threshold, a posttest script) failed, not the tests */
  tests_green?: boolean;
  /* the same command run at the session's base commit, only when the post-run failed: a failure that predates the work
     cannot be attributed to it */
  at_base?: { ran: boolean; passed?: boolean; exit_code?: number | null; summary?: { passed: number | null; failed: number | null }; reason?: string; duration_ms?: number };
  /* false when the failure is explained by tests_green or by the base commit failing the same way; undefined when passed */
  failure_attributable?: boolean;
}

/* The runner's own summary, when it prints one. Null fields mean "not stated", not zero. */
export function parseTestSummary(output: string): { passed: number | null; failed: number | null } {
  const num = (pats: RegExp[]): number | null => {
    for (const p of pats) {
      const m = p.exec(output);
      if (m?.[1] !== undefined) return Number(m[1]);
    }
    return null;
  };
  const passed = num([/(\d+)\s+passing/, /ℹ pass\s+(\d+)/, /#\s*pass\s+(\d+)/, /Tests:.*?(\d+) passed/, /(\d+) passed/]);
  let failed = num([/(\d+)\s+failing/, /ℹ fail\s+(\d+)/, /#\s*fail\s+(\d+)/, /Tests:.*?(\d+) failed/, /(\d+) failed/]);
  /* runners that print a pass line and no fail line at all (mocha with 0 failures, node:test) mean zero failures */
  if (failed === null && passed !== null && /(\d+\s+passing|ℹ pass\s+\d+|#\s*pass\s+\d+)/.test(output)) failed = 0;
  return { passed, failed };
}

/* Whether a failed run is attributable to the work. false: the tests themselves were green and a later stage failed.
   true: the base commit passes, or fails with fewer failing tests than now. undefined: unknown, which includes a base
   that fails with the same count (the failing tests may be the ones the task was meant to fix, as in a bug-fix task,
   or unrelated pre-existing failures; only a reading of the task can tell, so the criterion stays unmet with the base
   facts on it rather than being excused mechanically). */
export function failureAttributable(v: VerificationResult): boolean | undefined {
  if (!v.ran || v.passed !== false) return undefined;
  if (v.tests_green) return false;
  if (v.at_base?.ran) {
    if (v.at_base.passed) return true;
    const after = v.summary?.failed;
    const before = v.at_base.summary?.failed;
    if (after != null && before != null && after > before) return true;
    return undefined;
  }
  return true;
}

/* Run the same command at the base commit in a detached worktree (dependencies shared through a junction to the
   session's node_modules when present), then remove the worktree. Never touches the session's tree. */
export async function runAtBase(cwd: string, base: string, command: string, timeoutMs: number): Promise<NonNullable<VerificationResult['at_base']>> {
  const started = Date.now();
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-base-'));
  const dir = path.join(wt, 'repo');
  try {
    const add = await runProcess('git', ['worktree', 'add', '--detach', dir, base], { cwd, timeoutMs: 120000 });
    if (add.code !== 0) return { ran: false, reason: `could not check out the base commit: ${(add.stderr || add.stdout).trim().slice(-200)}` };
    const mods = path.join(cwd, 'node_modules');
    if (fs.existsSync(mods) && !fs.existsSync(path.join(dir, 'node_modules'))) {
      try {
        fs.symlinkSync(mods, path.join(dir, 'node_modules'), 'junction');
      } catch {
        /* no link: the run below will say what is missing */
      }
    }
    const isWin = process.platform === 'win32';
    const r = await runProcess(isWin ? 'cmd.exe' : 'sh', isWin ? ['/d', '/s', '/c', `"${command}"`] : ['-c', command], { cwd: dir, timeoutMs, env: scrubEnv(), replaceEnv: true });
    const out = (r.stdout + '\n' + r.stderr).trim();
    return { ran: true, passed: !r.timedOut && r.code === 0, exit_code: r.code, summary: parseTestSummary(out), duration_ms: Date.now() - started };
  } catch (err) {
    return { ran: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      fs.rmSync(path.join(dir, 'node_modules'), { force: true });
    } catch {
      /* a junction that is already gone */
    }
    await runProcess('git', ['worktree', 'remove', '--force', dir], { cwd, timeoutMs: 60000 }).catch(() => undefined);
    fs.rmSync(wt, { recursive: true, force: true, maxRetries: 3 });
  }
}

export const NO_CONSENT_REASON = 'tests not run: no consent';

/* Environment passed to a test re-run: a small allowlist plus nothing that looks like a credential. */
const ENV_KEEP = new Set(['PATH', 'Path', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'TEMP', 'TMP', 'TMPDIR', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'windir', 'COMSPEC', 'ComSpec', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'ProgramFiles', 'PROGRAMDATA', 'ProgramData', 'USER', 'USERNAME', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'CI', 'NODE_ENV', 'NODE_OPTIONS', 'npm_config_cache', 'GOPATH', 'GOROOT', 'GOCACHE', 'CARGO_HOME', 'RUSTUP_HOME', 'JAVA_HOME', 'PYTHONPATH', 'PYTHONHOME', 'VIRTUAL_ENV', 'NVM_DIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']);
const SECRET_LIKE = /(TOKEN|SECRET|KEY|PASSWORD|PASSWD|PWD|AUTH|CREDENTIAL|COOKIE|SESSION|PRIVATE|CERT|API|JIRA|LINEAR|ANTHROPIC|OPENAI|GITHUB|GH_|AWS_|AZURE_|GCP_|GOOGLE_|STRIPE|SLACK|TWILIO|DATABASE_URL|DB_|REDIS|MONGO|POSTGRES|NPM_|VERCEL|CLAUDE)/i;

export function scrubEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (ENV_KEEP.has(k)) out[k] = v;
    else if (!SECRET_LIKE.test(k) && !/^(TALLY_|CLAUDE_)/.test(k) && !/^[A-Z0-9_]*(TOKEN|KEY|SECRET)[A-Z0-9_]*$/i.test(k) && v.length < 200 && !/^(sk-|ghp_|xox|AKIA|eyJ)/.test(v)) out[k] = v;
  }
  out.TALLY_INTERNAL = '1';
  out.TALLY_TEST_RERUN = '1';
  return out;
}

export async function runVerification(cwd: string, opts: { timeoutMs: number; command?: string; enabled?: boolean; consent?: boolean; baseHead?: string }): Promise<VerificationResult> {
  if (opts.enabled === false) return { ran: false, reason: 'disabled in config (judge.run_tests=false)' };
  if (opts.consent !== true) return { ran: false, reason: NO_CONSENT_REASON, consent: opts.consent };
  const detected = opts.command ? { command: opts.command, basis: 'configured' } : detectTestCommand(cwd);
  if (!detected) return { ran: false, reason: 'no test command detected', consent: true };
  const started = Date.now();
  const isWin = process.platform === 'win32';
  const r = await runProcess(isWin ? 'cmd.exe' : 'sh', isWin ? ['/d', '/s', '/c', `"${detected.command}"`] : ['-c', detected.command], { cwd, timeoutMs: opts.timeoutMs, env: scrubEnv(), replaceEnv: true });
  const out = (r.stdout + '\n' + r.stderr).trim();
  const passed = !r.timedOut && r.code === 0;
  const summary = parseTestSummary(out);
  const result: VerificationResult = {
    ran: true,
    command: detected.command,
    basis: detected.basis,
    passed,
    exit_code: r.code,
    timed_out: r.timedOut,
    duration_ms: Date.now() - started,
    output_tail: out.length > 3000 ? '…' + out.slice(-3000) : out,
    env_scrubbed: true,
    consent: true,
    summary,
    tests_green: !passed && !r.timedOut && summary.passed !== null && summary.passed > 0 && summary.failed === 0,
  };
  /* the post-run failed: was the base already failing? one more run, in a throwaway worktree, decides attribution */
  if (!passed && opts.baseHead) {
    result.at_base = await runAtBase(cwd, opts.baseHead, detected.command, opts.timeoutMs);
  }
  result.failure_attributable = failureAttributable(result);
  return result;
}
