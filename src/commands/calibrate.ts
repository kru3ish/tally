import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Args, flag, has } from '../cli.js';
import readline from 'node:readline';
import { addCalibration, buildCalibrationReport, parseStatuses, parseVerdict, readCalibration, renderCalibrationReport, type CalibrationEntry } from '../calibrate/calibrate.js';
import { rescoreCalibration } from '../calibrate/calibrate.js';
import { gradeSession } from '../calibrate/grade.js';
import { loadBaseline, runEval, renderOverheadTable } from '../calibrate/eval.js';
import { renderSummary } from '../judge/judge.js';
import { loadJudge } from '../judge/judge.js';
import { resolveSession } from '../session.js';

export async function run(args: Args): Promise<number | void> {
  const sub = args._[0];
  if (sub === 'add') {
    const session = resolveSession(args._[1] ?? flag(args, 'session'), process.cwd());
    const human = flag(args, 'human');
    if (!session || !human) {
      process.stderr.write('Usage: tally calibrate add <session> --human met,partial,unmet,unverifiable[,...] [--verdict "worth it"|borderline|"not worth it"]\n');
      return 1;
    }
    const judge = loadJudge(session);
    if (!judge) {
      process.stderr.write(`No receipt for ${session}. Run tally judge first.\n`);
      return 1;
    }
    try {
      const entry = addCalibration(session, parseStatuses(human), parseVerdict(flag(args, 'verdict')));
      process.stdout.write(`Recorded ${entry.criteria.length} grade(s) for "${entry.task_title}":\n`);
      for (const c of entry.criteria) process.stdout.write(`  ${c.id} human ${c.human.padEnd(12)} judge ${c.judge.padEnd(12)} ${c.human === c.judge ? 'agree' : 'DISAGREE'}  ${c.text.slice(0, 60)}\n`);
      if (entry.human_verdict) process.stdout.write(`  verdict: human ${entry.human_verdict}, judge ${entry.judge_verdict}\n`);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
    return;
  }
  if (sub === 'grade') {
    const session = resolveSession(args._[1] ?? flag(args, 'session'), process.cwd());
    if (!session || !loadJudge(session)) {
      process.stderr.write('Usage: tally calibrate grade <session> [--grader name]   (the session needs a receipt: tally backfill add or tally judge)\n');
      return 1;
    }
    const grader = flag(args, 'grader') ?? os.userInfo().username;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));
    try {
      await gradeSession(session, { grader, ask, out: (s) => process.stdout.write(s + '\n') });
    } finally {
      rl.close();
    }
    process.stdout.write('\nReport: tally calibrate report --source backfill\n');
    return;
  }
  if (sub === 'rescore') {
    const r = rescoreCalibration({ grader: flag(args, 'grader'), source: 'backfill' });
    process.stdout.write(`${r.rescored.length} entr${r.rescored.length === 1 ? 'y' : 'ies'} rescored against the current receipts (human grades unchanged)${r.rescored.length ? ': ' + r.rescored.map((s) => s.slice(0, 8)).join(', ') : ''}\n`);
    for (const s of r.skipped) process.stdout.write(`  skipped ${s.session.slice(0, 8)}: ${s.why}\n`);
    return;
  }
  if (sub === 'report' || !sub) {
    const source = flag(args, 'source');
    const all = readCalibration();
    const sections: Array<[string, CalibrationEntry[]]> = source ? [[source, all.filter((e) => e.source === source)]] : [['backfill', all.filter((e) => e.source === 'backfill')], ['human', all.filter((e) => e.source === 'human')]];
    for (const [name, entries] of sections) {
      process.stdout.write(renderCalibrationReport(buildCalibrationReport(entries), name === 'backfill' ? 'Backfill calibration (real sessions, blind-graded)' : name === 'fixture' ? 'Fixture calibration' : 'Calibration (receipts graded with calibrate add)') + '\n\n');
    }
    if (!source || source === 'fixture') {
      const b = loadBaseline();
      if (b) process.stdout.write(`Fixture regression baseline (kept separate from real sessions; ${b.judge_model ?? '?'}, ${b.recorded_at?.slice(0, 10) ?? '?'}): ${(b.criterion_agreement * 100).toFixed(0)}% criterion agreement, ${(b.verdict_agreement * 100).toFixed(0)}% verdict agreement, ${b.avg_share_pct ?? '?'}% average self-share. Run \`tally calibrate eval\` to re-check.\n`);
    }
    return;
  }
  if (sub === 'eval') {
    const live = has(args, 'live');
    const record = has(args, 'record');
    if (record && !live) {
      process.stderr.write('--record needs --live (it stores the real judge model output).\n');
      return 1;
    }
    const prevHome = process.env.TALLY_HOME;
    const keep = has(args, 'keep');
    if (!keep) process.env.TALLY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-cal-home-'));
    try {
      const only = flag(args, 'only')?.split(',').filter(Boolean);
      const s = await runEval({ live, record, only, deep: has(args, 'deep') });
      process.stdout.write(`Calibration eval (${live ? 'live judge model: ' + s.judge_model : 'recorded model output replayed through the pipeline'})\n\n`);
      for (const f of s.fixtures) process.stdout.write(`${f.verdict_match && f.matches === f.total ? 'ok  ' : 'diff'} ${f.name.padEnd(26)} ${f.matches}/${f.total} criteria · verdict ${f.judge_verdict}${f.verdict_match ? '' : ` (expected ${f.expected_verdict})`}${f.matches === f.total ? '' : '  [' + f.statuses.filter((x) => x.human !== x.judge).map((x) => `${x.id}: judge ${x.judge}, human ${x.human}`).join('; ') + ']'}\n`);
      process.stdout.write('\n' + renderCalibrationReport(s.report, 'Fixture agreement') + '\n');
      process.stdout.write('\nSelf-overhead (Tally spend as a share of each session)\n' + renderOverheadTable(s) + '\n');
      if (has(args, 'verbose')) for (const f of s.fixtures) process.stdout.write('\n' + renderSummary(loadJudge(f.name.startsWith('cal-') ? f.name : `cal-${f.name}`) ?? ({} as never), false) + '\n');
      const baseline = loadBaseline();
      const threshold = flag(args, 'fail-below') !== undefined ? Number(flag(args, 'fail-below')) : baseline ? baseline.criterion_agreement - 1e-9 : undefined;
      if (threshold !== undefined && s.criterion_agreement < threshold) {
        process.stderr.write(`\nFAIL: criterion agreement ${(s.criterion_agreement * 100).toFixed(1)}% is below ${(threshold * 100).toFixed(1)}%${baseline && flag(args, 'fail-below') === undefined ? ` (baseline recorded ${baseline.recorded_at?.slice(0, 10)})` : ''}.\n`);
        return 1;
      }
      const maxShare = flag(args, 'max-share') !== undefined ? Number(flag(args, 'max-share')) : undefined;
      if (maxShare !== undefined && s.avg_share_pct > maxShare) {
        process.stderr.write(`\nFAIL: average self-share ${s.avg_share_pct.toFixed(1)}% is above ${maxShare}%.\n`);
        return 1;
      }
      if (threshold !== undefined) process.stdout.write(`\nPASS: criterion agreement ${(s.criterion_agreement * 100).toFixed(1)}% ≥ ${(threshold * 100).toFixed(1)}%${maxShare !== undefined ? `; average self-share ${s.avg_share_pct.toFixed(1)}% ≤ ${maxShare}%` : ''}.\n`);
      if (record) process.stdout.write(s.baseline_updated ? `Recorded model outputs and baseline under test/fixtures/calibration/.\n` : `Nothing recorded: agreement ${(s.criterion_agreement * 100).toFixed(1)}% is below the current baseline; the previous model outputs and baseline stay.\n`);
    } finally {
      if (!keep) {
        fs.rmSync(process.env.TALLY_HOME!, { recursive: true, force: true });
        if (prevHome === undefined) delete process.env.TALLY_HOME;
        else process.env.TALLY_HOME = prevHome;
      }
    }
    return;
  }
  process.stderr.write('Usage: tally calibrate add|grade|rescore|report|eval\n');
  return 1;
}
