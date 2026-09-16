/* Fills the {{CALIBRATION_*}} placeholders in README.md and docs/launch/*.md from ~/.tally/calibration.jsonl
   (blind-graded backfill sessions). Run after `tally calibrate grade …`:  npx tsx scripts/fill-calibration.ts [--dry-run] */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCalibration, buildCalibrationReport } from '../src/calibrate/calibrate.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dry = process.argv.includes('--dry-run');
const entries = readCalibration().filter((e) => e.source === 'backfill');
const r = buildCalibrationReport(entries);
const sessions = new Set(entries.map((e) => e.session)).size;
const pct = (x: number | null) => (x === null ? 'n/a' : `${Math.round(x * 100)}%`);
const values: Record<string, string> = {
  CALIBRATION_SESSIONS: String(sessions),
  CALIBRATION_GRADERS: String(new Set(entries.map((e) => e.grader ?? 'me')).size),
  CALIBRATION_CRITERIA: String(r.total),
  CALIBRATION_CRITERION_AGREEMENT: pct(r.agreement),
  CALIBRATION_WITHIN_ONE_STEP: pct(r.lenient_agreement),
  CALIBRATION_VERDICTS: String(r.verdict_total),
  CALIBRATION_VERDICT_AGREEMENT: pct(r.verdict_agreement),
  CALIBRATION_LEAN: r.lean.lenient > r.lean.stricter ? `lenient on ${r.lean.lenient} of ${r.total}` : r.lean.stricter > r.lean.lenient ? `stricter on ${r.lean.stricter} of ${r.total}` : 'no lean',
  CALIBRATION_INTER_GRADER: r.inter_grader ? `${pct(r.inter_grader.agreement)} on ${r.inter_grader.criteria} criteria (${r.inter_grader.graders.join(', ')})` : 'one grader so far',
  CALIBRATION_COACH_PRECISION: r.coach.total ? `${r.coach.useful} of ${r.coach.total} replayed suggestions marked useful (${pct(r.coach.precision)})` : 'no replayed suggestions graded yet',
  CALIBRATION_DATE: new Date().toISOString().slice(0, 10),
};
if (!entries.length) {
  process.stderr.write('No blind-graded backfill sessions in ~/.tally/calibration.jsonl yet. Run: tally backfill list --since 60d; tally backfill add <session>; tally calibrate grade <session> --grader <you>\n');
  process.exit(1);
}
const files = [path.join(root, 'README.md'), ...fs.readdirSync(path.join(root, 'docs', 'launch')).filter((f) => f.endsWith('.md')).map((f) => path.join(root, 'docs', 'launch', f))];
for (const f of files) {
  const before = fs.readFileSync(f, 'utf8');
  const after = before.replace(/\{\{(CALIBRATION_[A-Z_]+)\}\}/g, (m, k: string) => values[k] ?? m);
  const left = after.match(/\{\{CALIBRATION_[A-Z_]+\}\}/g) ?? [];
  if (after !== before && !dry) fs.writeFileSync(f, after);
  process.stdout.write(`${path.relative(root, f)}: ${after === before ? 'nothing to fill' : dry ? 'would fill' : 'filled'}${left.length ? `; unknown placeholders left: ${left.join(' ')}` : ''}\n`);
}
process.stdout.write(Object.entries(values).map(([k, v]) => `  ${k} = ${v}`).join('\n') + '\n');
