/* `tally eval run|discover|report`: the evaluation loop as a command, so it is reproducible by anyone with the repo.

     tally eval run [--only id,id] [--class real] [--agent-model sonnet] [--grader-model opus] [--max-turns 80] [--keep]
     tally eval discover --repos owner/name,owner/name [--limit 10]
     tally eval report [--json]

   Results land in eval/results/ (public-safe JSON) and, per criterion, in ~/.tally/calibration.jsonl under the grader
   name `blind-eval`, so `tally calibrate report --grader blind-eval` gives the confusion table. */
import path from 'node:path';
import { type Args, flag, has } from '../cli.js';
import { loadTasks } from '../eval/tasks.js';
import { runEvalTask } from '../eval/run.js';
import { discover, writeCandidates } from '../eval/discover.js';
import { readLedger, aggregate } from '../eval/ledger.js';

export async function run(args: Args): Promise<number | void> {
  const sub = args._[0];
  if (sub === 'run') {
    const only = flag(args, 'only')?.split(',').filter(Boolean);
    const cls = flag(args, 'class');
    const tasks = loadTasks().filter((t) => (!only || only.includes(t.id)) && (!cls || t.class === cls));
    if (!tasks.length) {
      process.stderr.write(`No eval tasks matched under ${path.join(process.cwd(), 'eval', 'tasks')}. Add a spec (see docs/EVALUATION.md) or run \`tally eval discover\`.\n`);
      return 1;
    }
    let failures = 0;
    for (const t of tasks) {
      try {
        await runEvalTask({ task: t, agentModel: flag(args, 'agent-model'), graderModel: flag(args, 'grader-model'), maxTurns: flag(args, 'max-turns') ? Number(flag(args, 'max-turns')) : undefined, timeoutMin: flag(args, 'timeout-min') ? Number(flag(args, 'timeout-min')) : undefined, keep: has(args, 'keep'), claudeBin: flag(args, 'claude-bin') });
      } catch (err) {
        failures += 1;
        process.stderr.write(`[${t.id}] failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    return failures ? 1 : 0;
  }
  if (sub === 'discover') {
    const repos = flag(args, 'repos')?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
    if (!repos.length) {
      process.stderr.write('Usage: tally eval discover --repos owner/name,owner/name [--limit 10]\n');
      return 1;
    }
    const cands = await discover({ repos, limit: flag(args, 'limit') ? Number(flag(args, 'limit')) : undefined, out: (s) => process.stdout.write(s + '\n') });
    const dir = path.join(process.cwd(), 'eval', 'candidates');
    const files = writeCandidates(cands, dir);
    process.stdout.write(`\n${files.length} candidate(s) → ${path.relative(process.cwd(), dir)}\n`);
    for (const c of cands.slice(0, 20)) process.stdout.write(`  ${String(c.score).padStart(3)}  ${c.spec.id.padEnd(40)} ${c.title.slice(0, 70)}\n`);
    process.stdout.write('\nCurate: read the issue, write acceptance criteria into the spec, set test_command if npm test is wrong here, move it to eval/tasks/. Keep the ones Tally will do badly on too.\n');
    return;
  }
  if (sub === 'report' || sub === undefined) {
    const lines = readLedger();
    const agg = aggregate(lines);
    if (has(args, 'json')) {
      process.stdout.write(JSON.stringify({ schema: 'tally.eval-report.v1', runs: lines.length, by_class_and_version: agg }, null, 2) + '\n');
      return;
    }
    if (!lines.length) {
      process.stdout.write('No evaluation runs recorded yet (eval/results/ledger.jsonl). Run `tally eval run`.\n');
      return;
    }
    process.stdout.write(`Evaluation ledger: ${lines.length} run(s). Classes are reported separately on purpose; never one headline number.\n\n`);
    process.stdout.write(`${'class'.padEnd(11)}${'tally'.padEnd(8)}${'runs'.padStart(5)}${'criteria'.padStart(9)}${'exact'.padStart(7)}${'falseVER'.padStart(9)}${'falseUNMET'.padStart(11)}${'verdict'.padStart(9)}${'agent $'.padStart(9)}\n`);
    for (const a of agg) process.stdout.write(`${a.class.padEnd(11)}${a.version.padEnd(8)}${String(a.runs).padStart(5)}${String(a.criteria).padStart(9)}${`${a.exact}/${a.criteria}`.padStart(7)}${String(a.false_verified).padStart(9)}${String(a.false_unmet).padStart(11)}${(a.verdict_n ? `${a.verdict_agreement}/${a.verdict_n}` : '-').padStart(9)}${a.cost_usd.toFixed(2).padStart(9)}\n`);
    process.stdout.write('\nfalseVER: Tally VERIFIED, blind grader said partial or unmet (treated as a bug). falseUNMET: Tally UNMET, grader said met.\n');
    return;
  }
  process.stderr.write('Usage: tally eval run|discover|report\n');
  return 1;
}
