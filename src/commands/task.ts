import { spawn } from 'node:child_process';
import { type Args, flag, has } from '../cli.js';
import { receiptPredatesTask } from './finalize.js';
import { log } from '../paths.js';
import { loadConfig } from '../config.js';
import { makeLlm } from '../llm/client.js';
import { intake, loadTask, renderTask, confirmTask } from '../task/intake.js';
import { resolveSession } from '../session.js';
import { recordAssignment } from '../experiment/experiment.js';

export async function run(args: Args): Promise<number | void> {
  const cfg = loadConfig();
  const cwd = flag(args, 'cwd') || process.cwd();
  const session = resolveSession(flag(args, 'session'), cwd);
  if (!session) {
    process.stderr.write('No active Tally session found. Start Claude Code with Tally hooks installed, or pass --session <id>.\n');
    return 1;
  }
  if (has(args, 'confirm')) {
    const t = confirmTask(session);
    process.stdout.write(t ? `Confirmed: ${t.title} (${t.criteria.length} criteria)\n` : 'No task to confirm.\n');
    return t ? 0 : 1;
  }
  const editText = flag(args, 'edit');
  const linkRef = flag(args, 'link');
  if (editText || linkRef) {
    const r = await intake({ session, cwd, ref: linkRef, text: editText, cfg, llm: makeLlm({ session }), force: true });
    if (editText) confirmTask(session);
    process.stdout.write(renderTask(loadTask(session) ?? r.task) + '\n');
    return;
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
  recordAssignment(cwd, session);
  const llm = makeLlm({ session });
  const { task, created } = await intake({ session, cwd, ref: ref || undefined, text, cfg, llm, force: has(args, 'force'), noCache: has(args, 'no-cache') });
  if (!created && !has(args, 'auto')) process.stdout.write('(task already frozen for this session; use --force to replace)\n');
  /* the session may already have ended and been judged against the prompt while this intake ran; re-judge against the frozen task */
  if (created && has(args, 'auto') && receiptPredatesTask(session)) {
    log(`task: ${session} receipt predates the frozen task; re-judging`);
    spawn(process.execPath, [process.argv[1]!, 'judge', session, '--force', '--auto', '--reason', 'session_end'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
  if (!has(args, 'auto') || has(args, 'plain')) process.stdout.write(renderTask(task) + '\n');
}
