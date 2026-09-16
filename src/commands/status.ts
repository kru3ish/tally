import fs from 'node:fs';
import path from 'node:path';
import { type Args, flag, has } from '../cli.js';
import { loadConfig } from '../config.js';
import { resolveSession, sessionCwd, activeSessions } from '../session.js';
import { statusLine } from '../coach/ui.js';
import { loadTask, renderTask } from '../task/intake.js';
import { loadJudge, renderSummary } from '../judge/judge.js';
import { pendingInjects } from '../coach/inject.js';
import { sessionDir } from '../paths.js';

export async function run(args: Args): Promise<number | void> {
  const cfg = loadConfig();
  const session = resolveSession(flag(args, 'session'), process.cwd());
  const color = !has(args, 'plain');
  if (!session) {
    process.stdout.write('No tracked sessions yet. Install with `tally install`, then start Claude Code.\n');
    return;
  }
  const cwd = sessionCwd(session) ?? process.cwd();
  process.stdout.write(statusLine(session, cwd, cfg, color) + '\n');
  const active = activeSessions().find((s) => s.id === session);
  process.stdout.write(`state: ${active ? 'active' : 'ended'} · dir: ${sessionDir(session)}\n\n`);
  const task = loadTask(session);
  if (task) process.stdout.write(renderTask(task) + '\n\n');
  if (fs.existsSync(path.join(sessionDir(session), 'task.pending')) && !task) process.stdout.write('task intake is running in the background…\n\n');
  const judge = loadJudge(session);
  if (judge) process.stdout.write(renderSummary(judge, color) + '\n\n');
  const inj = pendingInjects(session);
  if (inj.length) process.stdout.write(`${inj.length} coach note(s) queued for the next turn.\n`);
}
