import { type Args, flag, has } from '../cli.js';
import { computeTrend, renderTrend } from '../report/report.js';
import { repoKey } from '../paths.js';

export async function run(args: Args): Promise<void> {
  const repo = has(args, 'all') ? undefined : flag(args, 'repo') ?? (has(args, 'here') ? repoKey(process.cwd()) : undefined);
  const days = flag(args, 'days') ? Number(flag(args, 'days')) : undefined;
  const t = computeTrend({ repo, days });
  if (has(args, 'json')) {
    process.stdout.write(JSON.stringify(t, null, 2) + '\n');
    return;
  }
  process.stdout.write(renderTrend(t, { repo, days }) + '\n');
}
