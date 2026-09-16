import fs from 'node:fs';
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
}

export async function runVerification(cwd: string, opts: { timeoutMs: number; command?: string; enabled?: boolean }): Promise<VerificationResult> {
  if (opts.enabled === false) return { ran: false, reason: 'disabled in config (judge.run_tests=false)' };
  const detected = opts.command ? { command: opts.command, basis: 'configured' } : detectTestCommand(cwd);
  if (!detected) return { ran: false, reason: 'no test command detected' };
  const started = Date.now();
  const isWin = process.platform === 'win32';
  const r = await runProcess(isWin ? 'cmd.exe' : 'sh', isWin ? ['/d', '/s', '/c', `"${detected.command}"`] : ['-c', detected.command], { cwd, timeoutMs: opts.timeoutMs });
  const out = (r.stdout + '\n' + r.stderr).trim();
  return {
    ran: true,
    command: detected.command,
    basis: detected.basis,
    passed: !r.timedOut && r.code === 0,
    exit_code: r.code,
    timed_out: r.timedOut,
    duration_ms: Date.now() - started,
    output_tail: out.length > 3000 ? '…' + out.slice(-3000) : out,
  };
}
