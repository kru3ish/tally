/* Blind grading: the grader sees the frozen criteria and a compact evidence summary, never Tally's statuses or verdict,
   until the grades are saved. */
import fs from 'node:fs';
import path from 'node:path';
import { loadJudge } from '../judge/judge.js';
import { loadTask } from '../task/intake.js';
import { sessionDir, appendLine, ensureDir, tallyHome } from '../paths.js';
import { calibrationFile, entryFromJudge, STATUSES, VERDICTS, type CalibrationEntry, type Status, type VerdictText } from './calibrate.js';
import type { CoachReplay } from '../backfill/events.js';

export type Ask = (question: string) => Promise<string>;

export interface GradeResult {
  entry: CalibrationEntry;
  reveal: string;
}

export function evidenceSummary(session: string): string {
  const j = loadJudge(session);
  const task = loadTask(session);
  if (!j || !task) throw new Error(`session ${session} has no receipt; run tally backfill add or tally judge first`);
  const L: string[] = [];
  L.push(`Task: ${task.title}${task.source.url ? `  (${task.source.url})` : ''}`);
  if (task.historical) L.push(`  ${task.historical.note}`);
  L.push('');
  L.push('Criteria (frozen at intake):');
  for (const c of task.criteria) L.push(`  ${c.id}. ${c.text}`);
  L.push('');
  L.push('Evidence:');
  L.push(`  diff: ${j.evidence.files_changed.length} file(s), +${j.evidence.insertions} −${j.evidence.deletions}${j.evidence.files_changed.length ? ' — ' + j.evidence.files_changed.slice(0, 12).join(', ') + (j.evidence.files_changed.length > 12 ? ', …' : '') : ''}`);
  if (j.evidence.diff_stat) L.push('  ' + j.evidence.diff_stat.split('\n').slice(0, 8).join('\n  '));
  L.push(`  tests: ${j.verification.ran ? `${j.verification.command} → ${j.verification.passed ? 'passed' : j.verification.timed_out ? 'timed out' : 'FAILED'}` : `not run (${j.verification.reason})`}`);
  if (j.evidence.command_runs.length) L.push(`  commands run in session: ${j.evidence.command_runs.map((c) => `${c.command} ${c.passed ? 'ok' : 'failed'}`).join('; ')}`);
  L.push(`  shipped: ${j.evidence.ship_events.map((s) => `${s.kind}${s.url ? ' ' + s.url : ''}`).join(', ') || 'no push/PR recorded'}`);
  if (j.followup) L.push(`  outcome: ${j.followup.notes.join(' ')}`);
  L.push(`  session cost: $${j.cost.total_usd.toFixed(2)}, ${j.evidence.tool_calls} tool calls`);
  L.push('');
  L.push('Final assistant message:');
  L.push('  ' + (j.evidence.final_message || '(none)').slice(0, 900).replace(/\n/g, '\n  '));
  return L.join('\n');
}

function statusFrom(answer: string): Status | null {
  const a = answer.trim().toLowerCase();
  if (!a) return null;
  if (a === 'm' || a === 'met') return 'met';
  if (a === 'p' || a.startsWith('part')) return 'partial';
  if (a === 'u' || a === 'unmet') return 'unmet';
  if (a === 'x' || a === '?' || a.startsWith('unv')) return 'unverifiable';
  return STATUSES.find((s) => s.startsWith(a)) ?? null;
}

function verdictFrom(answer: string): VerdictText | null {
  const a = answer.trim().toLowerCase();
  if (a === 'w' || a.startsWith('worth')) return 'worth it';
  if (a === 'b' || a.startsWith('border')) return 'borderline';
  if (a === 'n' || a.startsWith('not')) return 'not worth it';
  return VERDICTS.find((v) => v.startsWith(a)) ?? null;
}

export async function gradeSession(session: string, opts: { grader: string; ask: Ask; out: (s: string) => void }): Promise<GradeResult> {
  const j = loadJudge(session)!;
  const summary = evidenceSummary(session);
  const task = loadTask(session)!;
  opts.out(`Blind grading · session ${session.slice(0, 8)} · grader ${opts.grader}\n(Tally's own statuses and verdict stay hidden until you have graded.)\n`);
  opts.out(summary);
  let criteria = task.criteria.map((c) => ({ id: c.id, text: c.text }));
  let taskEdited = false;
  if (task.inferred) {
    opts.out(`\nThese criteria were inferred from the prompts${task.context?.branch ? `, branch "${task.context.branch}"` : ''}${task.context?.commits?.length ? ' and commits' : ''} (${task.confirmed ? 'confirmed' : 'unconfirmed'}). [a]ccept them or [e]dit: `);
    let choice = '';
    while (!/^[ae]$/.test(choice)) choice = (await opts.ask('  > ')).trim().toLowerCase();
    if (choice === 'e') {
      opts.out('  Enter each criterion as you understood the task (same count and order; empty keeps the original):');
      const edited: string[] = [];
      for (const c of criteria) {
        const line = (await opts.ask(`  ${c.id} [${c.text.slice(0, 60)}] > `)).trim();
        edited.push(line || c.text);
      }
      taskEdited = edited.some((t, i) => t !== criteria[i]!.text);
      criteria = criteria.map((c, i) => ({ id: c.id, text: edited[i]! }));
    }
  }
  opts.out('\nGrade each criterion: [m]et  [p]artial  [u]nmet  [x] unverifiable');
  const human: Status[] = [];
  for (const c of criteria) {
    let s: Status | null = null;
    while (!s) s = statusFrom(await opts.ask(`  ${c.id} "${c.text.slice(0, 80)}" > `));
    human.push(s);
  }
  let verdict: VerdictText | null = null;
  while (!verdict) verdict = verdictFrom(await opts.ask('Your verdict: [w]orth it  [b]orderline  [n]ot worth it > '));
  const replayPath = path.join(sessionDir(session), 'coach_replay.json');
  const replay = fs.existsSync(replayPath) ? (JSON.parse(fs.readFileSync(replayPath, 'utf8')) as CoachReplay) : null;
  const coach: CalibrationEntry['coach'] = [];
  if (replay?.shown.length) {
    opts.out(`\nThe Coach would have shown ${replay.shown.length} suggestion(s). Mark each [u]seful or [n]oise:`);
    for (const s of replay.shown) {
      let mark: 'useful' | 'noise' | null = null;
      while (!mark) {
        const a = (await opts.ask(`  [${s.rule}] ${s.title}: ${s.message.split('\n')[0]!.slice(0, 100)} > `)).trim().toLowerCase();
        mark = a === 'u' || a.startsWith('use') ? 'useful' : a === 'n' || a.startsWith('noi') ? 'noise' : null;
      }
      coach.push({ rule: s.rule, key: s.key, title: s.title, mark });
    }
  }
  const base = entryFromJudge(j, human, verdict, 'backfill');
  const entry: CalibrationEntry = { ...base, criteria: base.criteria.map((c, i) => ({ ...c, text: criteria[i]!.text })), grader: opts.grader, coach, task_edited: taskEdited };
  ensureDir(tallyHome());
  appendLine(calibrationFile(), JSON.stringify(entry));
  const R: string[] = [];
  R.push(`\nSaved. Tally's judgment, side by side (${j.tiers.ran.join(' → ')}):`);
  R.push(`  ${'criterion'.padEnd(12)} ${'you'.padEnd(13)} ${'tally'.padEnd(13)} evidence`);
  for (const c of entry.criteria) R.push(`  ${c.id.padEnd(12)} ${c.human.padEnd(13)} ${c.judge.padEnd(13)} ${c.human === c.judge ? '' : '≠ '}${c.evidence.slice(0, 90).replace(/\n/g, ' ')}`);
  R.push(`  ${'verdict'.padEnd(12)} ${verdict.padEnd(13)} ${j.verdict.verdict.padEnd(13)} ${verdict === j.verdict.verdict ? '' : '≠'}`);
  if (j.followup) R.push(`  follow-up: ${j.followup.final_status} → ${j.followup.final_verdict}`);
  if (coach.length) R.push(`  coach: ${coach.filter((c) => c.mark === 'useful').length}/${coach.length} marked useful`);
  const reveal = R.join('\n');
  opts.out(reveal);
  return { entry, reveal };
}
