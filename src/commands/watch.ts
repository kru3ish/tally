import { type Args, flag, has } from '../cli.js';
import { loadConfig } from '../config.js';
import { makeLlm } from '../llm/client.js';
import { resolveSession, sessionCwd, activeSessions } from '../session.js';
import { watch } from '../coach/ui.js';

export async function run(args: Args): Promise<number | void> {
  const cfg = loadConfig();
  const session = resolveSession(args._[0] ?? flag(args, 'session'), process.cwd());
  if (!session) {
    process.stderr.write('No active session. Start Claude Code in a repo with Tally hooks installed, then run `tally watch` again.\n');
    return 1;
  }
  const cwd = sessionCwd(session) ?? process.cwd();
  const active = activeSessions().find((s) => s.id === session);
  if (!active && !has(args, 'force')) process.stdout.write(`(session ${session.slice(0, 8)} is not marked active; watching anyway)\n`);
  await watch({ session, cwd, cfg, llm: has(args, 'no-llm') ? undefined : makeLlm({ session }), color: !has(args, 'plain') });
}
