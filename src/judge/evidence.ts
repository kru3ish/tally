import { spawnSync } from 'node:child_process';
import type { Transcript } from '../transcript/parse.js';
import { isTestCommand, isLintCommand } from '../transcript/parse.js';
import type { TallyEvent } from '../store/events.js';
import { redact } from '../redact.js';
import { reconstructChanges, type Reconstruction } from './reconstruct.js';

export interface GitEvidence {
  base_head?: string;
  current_head?: string;
  files_changed: string[];
  diff_stat: string;
  insertions: number;
  deletions: number;
  diff_excerpt: string;
  branch?: string;
  error?: string;
}

export interface CommandRun {
  command: string;
  kind: 'test' | 'lint';
  passed: boolean;
  ts: string;
  output_tail: string;
}

export interface Evidence {
  git: GitEvidence;
  command_runs: CommandRun[];
  ship_events: Array<{ kind: string; command: string; url?: string; ts: string }>;
  final_messages: string[];
  prompts: string[];
  tool_call_count: number;
  edited_files: string[];
  reconstruction: Reconstruction;
}

export type Exec = (bin: string, args: string[], cwd: string) => { ok: boolean; stdout: string; stderr: string };

export const gitExec: Exec = (bin, args, cwd) => {
  const r = spawnSync(bin, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 20 * 1024 * 1024 });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

export function collectGit(cwd: string, baseHead: string | undefined, exec: Exec = gitExec, maxDiffChars = 60000): GitEvidence {
  const out: GitEvidence = { base_head: baseHead, files_changed: [], diff_stat: '', insertions: 0, deletions: 0, diff_excerpt: '' };
  const head = exec('git', ['rev-parse', 'HEAD'], cwd);
  if (!head.ok) {
    out.error = 'not a git repository or git unavailable';
    return out;
  }
  out.current_head = head.stdout.trim();
  const br = exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (br.ok) out.branch = br.stdout.trim();
  /* any tree-ish works as a base (a commit, or the empty tree for a repo created during the session) */
  const base = baseHead && exec('git', ['cat-file', '-e', baseHead], cwd).ok ? baseHead : undefined;
  const range = base ? [base] : ['HEAD'];
  const stat = exec('git', ['diff', '--stat', ...range], cwd);
  out.diff_stat = stat.stdout.trim();
  const names = exec('git', ['diff', '--name-only', ...range], cwd);
  const files = new Set(names.stdout.split('\n').map((s) => s.trim()).filter(Boolean));
  const untracked = exec('git', ['ls-files', '--others', '--exclude-standard'], cwd);
  for (const f of untracked.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) files.add(f);
  out.files_changed = [...files].sort();
  const numstat = exec('git', ['diff', '--numstat', ...range], cwd);
  for (const line of numstat.stdout.split('\n')) {
    const [a, d] = line.split('\t');
    out.insertions += Number(a) || 0;
    out.deletions += Number(d) || 0;
  }
  const diff = exec('git', ['diff', ...range, '--', '.', ':(exclude)package-lock.json', ':(exclude)*.lock', ':(exclude)dist/'], cwd);
  let text = diff.stdout;
  for (const f of untracked.stdout.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 20)) {
    const show = exec('git', ['diff', '--no-index', '--', '/dev/null', f], cwd);
    const body = show.stdout || show.stderr;
    if (body) text += `\n${body}`;
  }
  out.diff_excerpt = redact(text.length > maxDiffChars ? text.slice(0, maxDiffChars) + `\n…[diff truncated, ${text.length} chars total]` : text);
  if (!base && baseHead) out.error = `session-start HEAD ${baseHead.slice(0, 8)} not found; diff is against current HEAD`;
  return out;
}

export function collectEvidence(opts: { cwd: string; transcript: Transcript; events: TallyEvent[]; exec?: Exec; skipGit?: boolean }): Evidence {
  const { transcript: t, events } = opts;
  const startEv = events.find((e) => e.type === 'session_start');
  const baseHead = typeof startEv?.data.git_head === 'string' ? startEv.data.git_head : undefined;
  const git: GitEvidence = opts.skipGit ? { base_head: baseHead, files_changed: [], diff_stat: '', insertions: 0, deletions: 0, diff_excerpt: '', error: 'no git tree for this session; changes reconstructed from the transcript' } : collectGit(opts.cwd, baseHead, opts.exec);

  const command_runs: CommandRun[] = [];
  for (const c of t.toolCalls) {
    if (c.name !== 'Bash' || c.agent !== 'main') continue;
    const cmd = typeof c.input.command === 'string' ? c.input.command : '';
    const kind = isTestCommand(cmd) ? 'test' : isLintCommand(cmd) ? 'lint' : null;
    if (!kind) continue;
    const tail = c.result?.text ?? '';
    command_runs.push({ command: redact(cmd).slice(0, 200), kind, passed: !c.result?.isError, ts: c.ts, output_tail: redact(tail.length > 600 ? '…' + tail.slice(-600) : tail) });
  }

  const ship_events = events
    .filter((e) => e.type === 'ship')
    .map((e) => ({ kind: String(e.data.kind ?? 'push'), command: String(e.data.command ?? ''), url: typeof e.data.url === 'string' ? e.data.url : undefined, ts: e.ts }));

  const mainTexts = t.messages.filter((m) => m.agent === 'main' && m.text.trim()).map((m) => m.text.trim());
  const final_messages = mainTexts.slice(-3).map((s) => redact(s.length > 2500 ? s.slice(0, 2500) + '…' : s));
  const prompts = t.prompts.map((p) => redact(p.text.length > 1200 ? p.text.slice(0, 1200) + '…' : p.text));
  const edited = new Set<string>();
  for (const c of t.toolCalls) {
    if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(c.name) && typeof c.input.file_path === 'string') edited.add(c.input.file_path.replace(/\\/g, '/'));
  }
  const reconstruction = reconstructChanges(t, git.files_changed, opts.cwd);
  return { git, command_runs, ship_events, final_messages, prompts, tool_call_count: t.toolCalls.length, edited_files: [...edited].sort(), reconstruction };
}
