/* `tally estimate "<story>"`: what a story like this has cost before, from the sessions already on this machine.
   `--backtest` estimates every past story from all the others and reports how far off the method is here. */
import { type Args, flag, has } from '../cli.js';
import { backtest, buildCorpus, estimateFromCorpus, fmtEstimate } from '../estimate/estimate.js';
import { fetchTask } from '../task/fetchers.js';
import { loadConfig } from '../config.js';

const $ = (n: number) => `$${n.toFixed(2)}`;

export async function run(args: Args): Promise<number | void> {
  const corpus = buildCorpus({ since: flag(args, 'since') });
  if (has(args, 'backtest')) {
    const b = backtest(corpus);
    if (has(args, 'json')) {
      process.stdout.write(JSON.stringify(b, null, 2) + '\n');
      return;
    }
    process.stdout.write(
      [
        `Backtest over ${b.sessions} past stories on this machine (each estimated from all the others):`,
        `  median error           ${b.median_abs_pct_error}%`,
        `  within 2x of actual    ${b.within_2x_pct}%`,
        `  inside the stated range ${b.inside_range_pct}%`,
        `  had similar neighbours ${b.similar.sessions} (median error ${b.similar.median_abs_pct_error}%, within 2x ${b.similar.within_2x_pct}%)`,
        'More history makes it better: every finished session becomes an example.',
        '',
      ].join('\n'),
    );
    return;
  }
  const ref = args._.join(' ').trim();
  if (!ref) {
    process.stderr.write('Usage: tally estimate "<story text>" | <github/jira/linear url> | <file.md>   [--backtest] [--json]\n');
    return 2;
  }
  /* a tracker link or a file is read the same way task intake reads it, so the estimate sees the story's words */
  const fetched = await fetchTask(ref, { cwd: process.cwd(), cfg: loadConfig(), promptText: ref });
  const text = `${fetched.title}\n${fetched.body}`;
  const e = estimateFromCorpus(text, corpus, { cwd: process.cwd() });
  if (has(args, 'json')) {
    process.stdout.write(JSON.stringify(e, null, 2) + '\n');
    return;
  }
  const L = [`Story:    ${fetched.title.slice(0, 90)}`, `Estimate: ${fmtEstimate(e)}`];
  if (e.neighbours.length) {
    L.push('', 'Most similar past stories:');
    for (const n of e.neighbours) L.push(`  ${$(n.cost_usd).padStart(8)}  ${n.similarity.toFixed(2)}  ${n.text.slice(0, 70)}${n.models[0] ? `  (${n.models[0]})` : ''}`);
  }
  L.push('', `Based on ${e.corpus} past stories on this machine. Nothing was sent anywhere.`);
  process.stdout.write(L.join('\n') + '\n');
}
