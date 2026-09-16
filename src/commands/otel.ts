import { type Args, flag, has } from '../cli.js';
import { startOtelReceiver, otelSetupEnv, otelFile, readOtelPoints, otelCostForSession } from '../cost/otel.js';

export async function run(args: Args): Promise<number | void> {
  if (has(args, 'status') || args._[0] === 'status') {
    const points = readOtelPoints();
    const sessions = new Set(points.map((p) => p.attrs['session.id']).filter((s): s is string => !!s));
    process.stdout.write(`${points.length} metric point(s) from ${sessions.size} session(s) in ${otelFile()}\n`);
    for (const s of [...sessions].slice(-5)) process.stdout.write(`  ${s}: $${otelCostForSession(s, points).total_usd.toFixed(4)}\n`);
    return;
  }
  const port = Number(flag(args, 'port') ?? 4318);
  const { port: bound } = await startOtelReceiver({
    port,
    onPoints: (p) => {
      const cost = p.filter((x) => x.name === 'claude_code.cost.usage').reduce((s, x) => s + x.value, 0);
      if (cost > 0) process.stdout.write(`  +$${cost.toFixed(4)} (${p.length} points)\n`);
    },
  });
  const env = otelSetupEnv(bound);
  process.stdout.write(`Tally OTel receiver listening on http://127.0.0.1:${bound}/v1/metrics → ${otelFile()}\n\nStart Claude Code with these variables (put them in your shell profile or ~/.claude/settings.json "env"):\n`);
  for (const [k, v] of Object.entries(env)) process.stdout.write(`  ${k}=${v}\n`);
  process.stdout.write('\nReceipts will then show an OTel cross-check next to the transcript cost. Ctrl-C to stop.\n');
  await new Promise(() => {});
}
