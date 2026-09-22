/* Blind grading without the interactive prompts.
     npx tsx scripts/grading-sheet.ts            writes ~/.tally/grading-sheet.md: one section per receipt (criteria,
                                                 evidence, replayed Coach suggestions) and an ANSWERS line to fill in
     npx tsx scripts/grading-sheet.ts --import   reads the filled ANSWERS lines and records them exactly as
                                                 `tally calibrate grade` would; Tally's side-by-side reveal goes to
                                                 ~/.tally/grading-reveal.md instead of the screen
   Sessions already graded by the same grader are skipped. Nothing here prints Tally's statuses or verdicts. */
import fs from 'node:fs';
import path from 'node:path';
import { tallyHome, sessionDir } from '../src/paths.js';
import { loadJudge } from '../src/judge/judge.js';
import { loadTask } from '../src/task/intake.js';
import { evidenceSummary, gradeSession } from '../src/calibrate/grade.js';
import { readCalibration } from '../src/calibrate/calibrate.js';
import type { CoachReplay } from '../src/backfill/events.js';

const grader = process.argv.find((a, i) => process.argv[i - 1] === '--grader') ?? 'krish';
const sheet = path.join(tallyHome(), 'grading-sheet.md');
const revealFile = path.join(tallyHome(), 'grading-reveal.md');
const graded = new Set(readCalibration().filter((e) => e.source === 'backfill' && (e.grader ?? '') === grader).map((e) => e.session));
const sessions = fs
  .readdirSync(path.join(tallyHome(), 'sessions'))
  .filter((s) => fs.existsSync(path.join(sessionDir(s), 'judge.json')) && loadJudge(s) && loadTask(s) && !graded.has(s))
  .sort();

function replayOf(session: string): CoachReplay | null {
  const p = path.join(sessionDir(session), 'coach_replay.json');
  return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) as CoachReplay) : null;
}

if (!process.argv.includes('--import')) {
  const L: string[] = [];
  L.push(`# Tally blind grading sheet · grader ${grader}`);
  L.push('');
  L.push('For each session fill the ANSWERS line and leave everything else alone. Letters, separated by spaces:');
  L.push('  criteria: one per criterion in order   m = met   p = partial   u = unmet   x = cannot tell');
  L.push('  verdict:  w = worth it   b = borderline   n = not worth it');
  L.push('  coach:    one per suggestion in order   u = useful (you would have wanted to see it)   n = noise');
  L.push('Leave a session\'s ANSWERS line empty to skip it. Then run: npx tsx scripts/grading-sheet.ts --import');
  L.push('');
  for (const s of sessions) {
    const task = loadTask(s)!;
    const replay = replayOf(s);
    L.push(`---`);
    L.push(`## ${s}`);
    L.push('```');
    L.push(evidenceSummary(s));
    L.push('```');
    if (replay?.shown.length) {
      L.push(`Coach suggestions the replay would have shown (${replay.shown.length}):`);
      replay.shown.forEach((x, i) => L.push(`  s${i + 1}. [${x.rule}] ${x.title}: ${x.message.split('\n')[0]!.slice(0, 140)}`));
    } else L.push('Coach suggestions the replay would have shown: none');
    L.push('');
    L.push(`ANSWERS ${s.slice(0, 8)}: criteria=${' _'.repeat(task.criteria.length).trim()}  verdict=_  coach=${replay?.shown.length ? ' _'.repeat(replay.shown.length).trim() : '-'}`);
    L.push('');
  }
  fs.writeFileSync(sheet, L.join('\n') + '\n');
  process.stdout.write(`${sessions.length} session(s) to grade → ${sheet}\n`);
} else {
  const text = fs.readFileSync(sheet, 'utf8');
  const answers = new Map<string, { criteria: string[]; verdict: string; coach: string[] }>();
  for (const m of text.matchAll(/^ANSWERS (\w{8}): criteria=([^\n]*?)\s+verdict=(\S*)\s+coach=([^\n]*)$/gm)) {
    const crit = m[2]!.trim().split(/\s+/).filter((t) => /^[mpux]$/i.test(t));
    const verdict = m[3]!.trim();
    const coach = m[4]!.trim().split(/\s+/).filter((t) => /^[un]$/i.test(t));
    if (crit.length && /^[wbn]$/i.test(verdict)) answers.set(m[1]!, { criteria: crit, verdict, coach });
  }
  let done = 0;
  const reveal: string[] = [`# Tally's answers next to yours · grader ${grader} · ${new Date().toISOString()}`, ''];
  for (const s of sessions) {
    const a = answers.get(s.slice(0, 8));
    if (!a) continue;
    const task = loadTask(s)!;
    const judge = loadJudge(s)!;
    if (judge.criteria.length !== task.criteria.length) {
      process.stdout.write(`${s.slice(0, 8)}: skipped, the receipt has ${judge.criteria.length} criteria but the task now has ${task.criteria.length} (re-run tally judge first)
`);
      continue;
    }
    const replay = replayOf(s);
    const nCoach = replay?.shown.length ?? 0;
    if (a.criteria.length !== task.criteria.length) {
      process.stdout.write(`${s.slice(0, 8)}: skipped, ${a.criteria.length} criterion letter(s) given but the task has ${task.criteria.length}\n`);
      continue;
    }
    if (a.coach.length !== nCoach) {
      process.stdout.write(`${s.slice(0, 8)}: skipped, ${a.coach.length} coach letter(s) given but the replay has ${nCoach}\n`);
      continue;
    }
    const queue = [...(task.inferred ? ['a'] : []), ...a.criteria, a.verdict, ...a.coach];
    let out = '';
    await gradeSession(s, { grader, ask: async () => queue.shift() ?? '', out: (line) => (out += line + '\n') });
    reveal.push(`## ${s}`, '```', out.slice(out.indexOf('Saved.')), '```', '');
    done += 1;
    process.stdout.write(`${s.slice(0, 8)}: recorded\n`);
  }
  fs.writeFileSync(revealFile, reveal.join('\n'));
  process.stdout.write(`${done} session(s) recorded. Tally's answers next to yours: ${revealFile}\n`);
}
