import type { Args } from '../cli.js';
import { loadConfig, saveConfig, setTestRerunConsent, testRerunConsent } from '../config.js';
import { configFile } from '../paths.js';
import { unmuteRule, loadMutes } from '../coach/engine.js';

export async function run(args: Args): Promise<number | void> {
  const [key, value] = args._;
  if (key === 'unmute' && value) {
    unmuteRule(process.cwd(), value);
    process.stdout.write(`Unmuted ${value} for this repo.\n`);
    return;
  }
  if (key === 'consent') {
    if (value === 'on' || value === 'off') {
      setTestRerunConsent(process.cwd(), value === 'on');
      process.stdout.write(`Test re-runs ${value === 'on' ? 'allowed' : 'disallowed'} for ${process.cwd()}\n`);
      return;
    }
    const c = testRerunConsent(loadConfig(), process.cwd());
    process.stdout.write(`Test re-runs in ${process.cwd()}: ${c === undefined ? 'not asked yet' : c ? 'allowed' : 'disallowed'}  (tally config consent on|off)\n`);
    return;
  }
  if (key === 'mutes') {
    process.stdout.write(JSON.stringify(loadMutes(), null, 2) + '\n');
    return;
  }
  if (!key) {
    const cfg = loadConfig();
    process.stdout.write(`${configFile()}\n${JSON.stringify(cfg, null, 2)}\n`);
    return;
  }
  if (value === undefined) {
    process.stderr.write('Usage: tally config <key> <value>   e.g. tally config hourly_rate 120 | tally config models.judge opus | tally config writeback true\n');
    return 1;
  }
  const parsed: unknown = /^(true|false)$/.test(value) ? value === 'true' : /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
  const patch: Record<string, unknown> = {};
  let cur = patch;
  const parts = key.split('.');
  parts.forEach((p, i) => {
    if (i === parts.length - 1) cur[p] = parsed;
    else cur = cur[p] = {} as Record<string, unknown>;
  });
  try {
    const cfg = saveConfig(patch);
    process.stdout.write(`${key} = ${JSON.stringify(parsed)}\n`);
    void cfg;
  } catch (err) {
    process.stderr.write(`Invalid: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
