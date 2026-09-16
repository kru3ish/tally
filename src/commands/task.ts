import { type Args, flag, has } from '../cli.js';
import { loadConfig } from '../config.js';
import { makeLlm } from '../llm/client.js';
import { intake, loadTask, renderTask } from '../task/intake.js';
import { resolveSession } from '../session.js';

export async function run(args: Args): Promise<number | void> {
  const cfg = loadConfig();
  const cwd = flag(args, 'cwd') || process.cwd();
  const session = resolveSession(flag(args, 'session'), cwd);
  if (!session) {
    process.stderr.write('No active Tally session found. Start Claude Code with Tally hooks installed, or pass --session <id>.\n');
    return 1;
  }
  const text = flag(args, 'text');
  const ref = args._.join(' ').trim();
  if (!ref && !text) {
    const existing = loadTask(session);
    if (existing) {
      process.stdout.write(renderTask(existing) + '\n');
      return;
    }
    process.stderr.write('Usage: tally task <url|path|text>\n');
    return 1;
  }
  const llm = makeLlm({ session });
  const { task, created } = await intake({ session, cwd, ref: ref || undefined, text, cfg, llm, force: has(args, 'force') });
  if (!created && !has(args, 'auto')) process.stdout.write('(task already frozen for this session; use --force to replace)\n');
  if (!has(args, 'auto') || has(args, 'plain')) process.stdout.write(renderTask(task) + '\n');
}
