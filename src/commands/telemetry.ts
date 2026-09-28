/* `tally telemetry show|status|on|off|flush`: exactly what would be sent, whether it is, and the switch. */
import fs from 'node:fs';
import { type Args, has } from '../cli.js';
import { telemetryActive, enableTelemetry, disableTelemetry, exampleEvent, flush, queueFile, ALLOWED_FIELDS, TELEMETRY_SCHEMA } from '../telemetry/index.js';

export async function run(args: Args): Promise<number | void> {
  const sub = args._[0] ?? 'status';
  if (sub === 'on') {
    const s = enableTelemetry();
    const t = telemetryActive();
    process.stdout.write(`Anonymous metrics on. Installation id ${s.installation_id} (random, created now, deleted by \`tally telemetry off\`).\n${t.active ? `Sending to ${t.endpoint}.` : `Nothing is sent yet: ${t.reason}.`}\n`);
    return;
  }
  if (sub === 'off') {
    disableTelemetry();
    process.stdout.write('Anonymous metrics off. The installation id and any queued events were deleted.\n');
    return;
  }
  if (sub === 'flush') {
    const r = await flush();
    if (!has(args, 'auto')) process.stdout.write(r.skipped ? `Nothing sent: ${r.skipped}.\n` : `Sent ${r.sent} event(s)${r.status ? ` (HTTP ${r.status})` : ''}.\n`);
    return;
  }
  if (sub === 'show') {
    const t = telemetryActive();
    process.stdout.write(`Schema ${TELEMETRY_SCHEMA}. Fields that can ever be sent: ${ALLOWED_FIELDS.join(', ')}.\nNever sent: prompts, code, diffs, file names, repository names, task text, terminal output, hostnames, usernames.\n\nAn event looks like this:\n${JSON.stringify(exampleEvent(t.state), null, 2)}\n\n`);
    const q = queueFile();
    const pending = fs.existsSync(q) ? fs.readFileSync(q, 'utf8').split('\n').filter(Boolean) : [];
    process.stdout.write(pending.length ? `Queued, not yet sent (${pending.length}):\n${pending.map((l) => '  ' + l).join('\n')}\n\n` : 'Queue: empty.\n\n');
    process.stdout.write(`Status: ${t.active ? 'sending' : 'not sending'} (${t.reason}).\n`);
    return;
  }
  if (sub === 'status') {
    const t = telemetryActive();
    process.stdout.write(`Anonymous metrics: ${t.state.enabled ? 'on' : 'off'}; ${t.active ? 'sending' : 'not sending'} (${t.reason}).${t.state.installation_id ? ` Installation id ${t.state.installation_id}.` : ''}\n\`tally telemetry show\` prints exactly what would be sent; \`tally telemetry on|off\` switches it; TALLY_TELEMETRY=0 disables it in the environment.\n`);
    return;
  }
  process.stderr.write('Usage: tally telemetry show|status|on|off\n');
  return 1;
}
