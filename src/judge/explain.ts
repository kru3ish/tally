/* `tally judge <session> --explain <criterion|all>`: the evidence behind a status, so a reader can audit it in seconds:
   the cited evidence line, any override, the diff hunks for the files involved (from the session's base commit), the
   independent test run's output, and the transcript moments that touched those files. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadJudge } from './judge.js';
import { readEvents } from '../store/events.js';
import { transcriptPathFor } from '../session.js';
import { parseTranscriptFile } from '../transcript/parse.js';
import type { Judge } from './schema.js';

function baseCommit(j: Judge, session: string): string | undefined {
  if (j.historical?.start_head) return j.historical.start_head;
  const start = readEvents(session).find((e) => e.type === 'session_start');
  const head = start?.data.git_head;
  return typeof head === 'string' && head ? head : undefined;
}

function diffFor(cwd: string, base: string | undefined, files: string[], maxLines = 60): string {
  if (!base || !files.length || !fs.existsSync(path.join(cwd, '.git'))) return '';
  const r = spawnSync('git', ['diff', '--no-color', base, '--', ...files], { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0 || !r.stdout.trim()) return '';
  const lines = r.stdout.split('\n');
  return lines.slice(0, maxLines).join('\n') + (lines.length > maxLines ? `\n… ${lines.length - maxLines} more lines (git diff ${base.slice(0, 8)} -- ${files.join(' ')})` : '');
}

function moments(session: string, files: string[], max = 12): string[] {
  const p = transcriptPathFor(session);
  if (!p || !fs.existsSync(p) || !files.length) return [];
  let t;
  try {
    t = parseTranscriptFile(p);
  } catch {
    return [];
  }
  const names = files.map((f) => path.basename(f).toLowerCase());
  const out: string[] = [];
  for (const c of t.toolCalls) {
    const target = String(c.input.file_path ?? c.input.command ?? c.input.pattern ?? '').toLowerCase();
    if (!names.some((n) => target.includes(n))) continue;
    const what = c.name === 'Bash' ? String(c.input.command).slice(0, 80) : `${c.name} ${path.basename(String(c.input.file_path ?? ''))}`;
    out.push(`${c.ts.slice(11, 19)}  ${what}${c.result?.isError ? '  ✘' : ''}`);
    if (out.length >= max) break;
  }
  return out;
}

export function explainCriterion(session: string, id: string): string {
  const j = loadJudge(session);
  if (!j) return `No receipt for session ${session}.`;
  const c = j.criteria.find((x) => x.id === id);
  if (!c) return `No criterion ${id} on this receipt (${j.criteria.map((x) => x.id).join(', ')}).`;
  const L: string[] = [];
  L.push(`${c.id} · ${c.override ? `${c.override.original} → ${c.override.status} (disputed by ${c.override.by}: ${c.override.reason})` : c.status} · resolved by ${c.resolved_by}${c.confidence !== undefined && c.resolved_by !== 'tier0' ? ` at confidence ${c.confidence.toFixed(2)}` : ''}`);
  L.push(`  ${c.text}`);
  L.push('');
  L.push('Evidence cited');
  L.push(`  ${c.evidence}`);
  if (c.files.length) L.push(`  files: ${c.files.join(', ')}`);
  if (j.evidence.diff_source && j.evidence.diff_source !== 'git') L.push(`  note: changes were ${j.evidence.diff_source} from the transcript${j.evidence.reconstructed_files?.length ? ` (${j.evidence.reconstructed_files.length} file(s) not verified against disk)` : ''}`);
  const diff = j.cwd ? diffFor(j.cwd, baseCommit(j, session), c.files) : '';
  if (diff) {
    L.push('');
    L.push(`Diff for those files (from the session's base commit)`);
    L.push(diff.split('\n').map((x) => '  ' + x).join('\n'));
  }
  if (/tests|test suite|passes/i.test(c.text) || c.resolved_by === 'tier0') {
    L.push('');
    L.push('Independent verification');
    L.push(`  ${j.verification.ran ? `${j.verification.command} → ${j.verification.passed ? 'passed' : 'FAILED'}` : `not run (${j.verification.reason ?? 'unknown'})`}`);
    if (j.verification.output_tail) L.push(j.verification.output_tail.split('\n').slice(-15).map((x) => '  | ' + x).join('\n'));
  }
  const m = moments(session, c.files);
  if (m.length) {
    L.push('');
    L.push('Transcript moments touching those files');
    for (const x of m) L.push('  ' + x);
  }
  L.push('');
  L.push(`Disagree? tally dispute ${session.slice(0, 8)} ${c.id} --status <met|partial|unmet|unverifiable> --reason "<why>"`);
  return L.join('\n');
}

export function explainAll(session: string): string {
  const j = loadJudge(session);
  if (!j) return `No receipt for session ${session}.`;
  return j.criteria.map((c) => explainCriterion(session, c.id)).join('\n\n' + '─'.repeat(72) + '\n\n');
}
