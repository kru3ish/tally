import { type Args, flag, has } from '../cli.js';
import { loadConfig } from '../config.js';
import { followupSession, runDueFollowups } from '../followup/followup.js';
import { renderSummary } from '../judge/judge.js';
import { resolveSession } from '../session.js';

export async function run(args: Args): Promise<number | void> {
  const cfg = loadConfig();
  const plain = has(args, 'plain');
  if (has(args, 'auto') || has(args, 'all')) {
    const done = runDueFollowups(has(args, 'all') ? 0 : cfg.followup_days);
    if (!has(args, 'auto')) {
      if (!done.length) process.stdout.write('No receipts due for follow-up.\n');
      for (const j of done) process.stdout.write(`${j.task.title}: ${j.followup!.original_verdict} → ${j.followup!.final_verdict} (${j.followup!.final_status})\n`);
    }
    return;
  }
  const session = resolveSession(args._[0] ?? flag(args, 'session'), process.cwd());
  if (!session) {
    process.stderr.write('No session found.\n');
    return 1;
  }
  const j = followupSession(session);
  if (!j) {
    process.stderr.write(`Session ${session} has no receipt yet; run \`tally judge ${session}\` first.\n`);
    return 1;
  }
  process.stdout.write(renderSummary(j, !plain) + '\n');
  for (const n of j.followup!.notes) process.stdout.write(`  - ${n}\n`);
}
