/* Mechanical check specs: a criterion is `mechanical` when the intake model can express it as one of
   these checks, which Tier 0 resolves with no LLM. Anything else is `judgment`. */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Evidence } from './evidence.js';
import type { VerificationResult } from './verify.js';
import { runProcess } from '../llm/client.js';
import { scrubEnv, NO_CONSENT_REASON } from './verify.js';

export const CheckSpecSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tests_pass') }),
  z.object({ kind: z.literal('file_exists'), path: z.string().min(1) }),
  z.object({ kind: z.literal('file_changed'), path: z.string().min(1) }),
  z.object({ kind: z.literal('file_contains'), path: z.string().min(1), pattern: z.string().min(1) }),
  z.object({ kind: z.literal('diff_contains'), pattern: z.string().min(1) }),
  z.object({ kind: z.literal('command'), command: z.string().min(1), expect_exit: z.number().int().default(0) }),
  z.object({ kind: z.literal('pr'), state: z.enum(['pushed', 'opened', 'merged']).default('pushed') }),
]);
export type CheckSpec = z.infer<typeof CheckSpecSchema>;

export const CHECK_KINDS = ['tests_pass', 'file_exists', 'file_changed', 'file_contains', 'diff_contains', 'command', 'pr'] as const;

/* JSON-schema fragment the intake model fills in; `kind: "none"` means judgment. */
export const CHECK_JSON_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['none', ...CHECK_KINDS] },
    path: { type: 'string' },
    pattern: { type: 'string' },
    command: { type: 'string' },
    expect_exit: { type: 'number' },
    state: { type: 'string', enum: ['pushed', 'opened', 'merged'] },
  },
  required: ['kind'],
} as const;

export function parseCheck(raw: unknown): CheckSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { kind?: string };
  if (!r.kind || r.kind === 'none') return null;
  const p = CheckSpecSchema.safeParse(raw);
  return p.success ? p.data : null;
}

export interface CheckResult {
  status: 'met' | 'unmet' | 'unverifiable';
  evidence: string;
  files: string[];
}

function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function fileMatches(candidates: string[], wanted: string): string | undefined {
  const w = norm(wanted);
  return candidates.find((c) => {
    const n = norm(c);
    return n === w || n.endsWith('/' + w) || w.endsWith('/' + n);
  });
}

function safeRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

/* Commands are only run when they are the project's own scripts: the detected test command, or `npm run <script>` /
   `npx tsc --noEmit` / `make <target>` that exist in the repo. Anything else is treated as judgment. */
export function commandAllowed(command: string, cwd: string, testCommand?: string): boolean {
  const c = command.trim();
  if (testCommand && c === testCommand.trim()) return true;
  const m = /^(?:npm|pnpm|yarn|bun) run ([\w:.-]+)$/.exec(c) ?? /^npm (test|run\s+[\w:.-]+)$/.exec(c);
  if (m) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
      const script = m[1] === 'test' ? 'test' : m[1]!.replace(/^run\s+/, '');
      return !!pkg.scripts?.[script];
    } catch {
      return false;
    }
  }
  if (/^npx tsc( --noEmit)?( -p [\w./-]+)?$/.test(c)) return fs.existsSync(path.join(cwd, 'tsconfig.json'));
  if (/^make [\w-]+$/.test(c)) return fs.existsSync(path.join(cwd, 'Makefile'));
  if (/^(python -m )?pytest( -q)?$/.test(c) || /^go test \.\/\.\.\.$/.test(c) || /^cargo test$/.test(c)) return true;
  return false;
}

export async function resolveCheck(check: CheckSpec, ctx: { cwd: string; evidence: Evidence; verification: VerificationResult; consent?: boolean; timeoutMs: number; noTree?: boolean }): Promise<CheckResult> {
  const { evidence: ev, verification: ver } = ctx;
  /* No git tree for this session (backfill of uncommitted work): the working directory has moved on since, so a
     file or command check against it would answer a different question. The transcript's own Edit/Write calls are
     facts about what the session did, so file_changed and diff_contains can resolve from the reconstruction, labelled;
     everything else is unverifiable rather than unmet. */
  if (ctx.noTree && check.kind !== 'tests_pass' && check.kind !== 'pr') {
    const rec = ev.reconstruction;
    if (check.kind === 'file_changed') {
      const hit = check.path === '.' || check.path === '*' ? rec.changes[0]?.file : fileMatches(rec.changes.map((c) => c.file), check.path);
      return hit ? { status: 'met', evidence: `${hit} was written by the session (reconstructed from the transcript, not verified against disk)`, files: [hit] } : { status: 'unverifiable', evidence: `no git tree for this session and the transcript shows no write to ${check.path}`, files: [] };
    }
    if (check.kind === 'diff_contains') {
      const re = safeRegex(check.pattern);
      if (!re) return { status: 'unverifiable', evidence: `invalid pattern ${check.pattern}`, files: [] };
      const m = re.exec(rec.diff_text);
      return m ? { status: 'met', evidence: `reconstructed changes match /${check.pattern}/ ("${m[0].slice(0, 60)}"), not verified against disk`, files: [] } : { status: 'unverifiable', evidence: `no git tree for this session and the reconstructed changes do not match /${check.pattern}/`, files: [] };
    }
    return { status: 'unverifiable', evidence: `no git tree for this session; a ${check.kind} check needs a real tree`, files: [] };
  }
  switch (check.kind) {
    case 'tests_pass': {
      if (!ver.ran) return { status: 'unverifiable', evidence: `tests not run (${ver.reason ?? 'unknown'})`, files: [] };
      return ver.passed ? { status: 'met', evidence: `independent run of \`${ver.command}\` passed`, files: [] } : { status: 'unmet', evidence: `independent run of \`${ver.command}\` ${ver.timed_out ? 'timed out' : `failed (exit ${ver.exit_code})`}`, files: [] };
    }
    case 'file_exists': {
      const p = path.join(ctx.cwd, check.path);
      return fs.existsSync(p) ? { status: 'met', evidence: `${check.path} exists`, files: [check.path] } : { status: 'unmet', evidence: `${check.path} does not exist`, files: [] };
    }
    case 'file_changed': {
      /* "." or "*" from intake means "anything changed" */
      const hit = check.path === '.' || check.path === '*' ? ev.git.files_changed[0] : fileMatches(ev.git.files_changed, check.path);
      return hit ? { status: 'met', evidence: `${hit} is in the diff`, files: [hit] } : { status: 'unmet', evidence: `${check.path} is not in the diff (${ev.git.files_changed.length} files changed)`, files: [] };
    }
    case 'file_contains': {
      const p = path.join(ctx.cwd, check.path);
      if (!fs.existsSync(p)) return { status: 'unmet', evidence: `${check.path} does not exist`, files: [] };
      const re = safeRegex(check.pattern);
      if (!re) return { status: 'unverifiable', evidence: `invalid pattern ${check.pattern}`, files: [] };
      const body = fs.readFileSync(p, 'utf8');
      const m = re.exec(body);
      return m ? { status: 'met', evidence: `${check.path} matches /${check.pattern}/ ("${m[0].slice(0, 60)}")`, files: [check.path] } : { status: 'unmet', evidence: `${check.path} does not match /${check.pattern}/`, files: [check.path] };
    }
    case 'diff_contains': {
      const re = safeRegex(check.pattern);
      if (!re) return { status: 'unverifiable', evidence: `invalid pattern ${check.pattern}`, files: [] };
      const m = re.exec(ev.git.diff_excerpt);
      return m ? { status: 'met', evidence: `diff matches /${check.pattern}/ ("${m[0].slice(0, 60)}")`, files: [] } : { status: 'unmet', evidence: `diff does not match /${check.pattern}/`, files: [] };
    }
    case 'pr': {
      const kinds = ev.ship_events.map((s) => s.kind);
      const ok = check.state === 'pushed' ? kinds.length > 0 : check.state === 'opened' ? kinds.includes('pr') || kinds.includes('merge') : kinds.includes('merge');
      return ok ? { status: 'met', evidence: `ship events: ${kinds.join(', ')}`, files: [] } : { status: 'unmet', evidence: `no ${check.state} event recorded (${kinds.join(', ') || 'none'})`, files: [] };
    }
    case 'command': {
      if (!commandAllowed(check.command, ctx.cwd, ver.command)) return { status: 'unverifiable', evidence: `command not in the repo's own scripts, not run: ${check.command}`, files: [] };
      if (ctx.consent !== true) return { status: 'unverifiable', evidence: `${NO_CONSENT_REASON}: ${check.command}`, files: [] };
      if (ver.ran && ver.command === check.command) return ver.passed ? { status: 'met', evidence: `\`${check.command}\` exited 0 (independent run)`, files: [] } : { status: 'unmet', evidence: `\`${check.command}\` failed (exit ${ver.exit_code})`, files: [] };
      const isWin = process.platform === 'win32';
      const r = await runProcess(isWin ? 'cmd.exe' : 'sh', isWin ? ['/d', '/s', '/c', `"${check.command}"`] : ['-c', check.command], { cwd: ctx.cwd, timeoutMs: ctx.timeoutMs, env: scrubEnv(), replaceEnv: true });
      const ok = !r.timedOut && r.code === check.expect_exit;
      return ok ? { status: 'met', evidence: `\`${check.command}\` exited ${r.code}`, files: [] } : { status: 'unmet', evidence: `\`${check.command}\` ${r.timedOut ? 'timed out' : `exited ${r.code}, expected ${check.expect_exit}`}: ${(r.stdout + r.stderr).trim().slice(-300)}`, files: [] };
    }
  }
}
