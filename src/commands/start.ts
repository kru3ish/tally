import { spawnSync } from 'node:child_process';
import { type Args, has } from '../cli.js';

function exists(bin: string): boolean {
  const r = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [bin], { stdio: 'ignore', windowsHide: true });
  return r.status === 0;
}

/* Opens the Coach beside Claude Code: a tmux split when inside tmux, a new tmux session when tmux exists,
   a Windows Terminal split when `wt` exists, otherwise the command to run in a second terminal. */
export function startPlan(env: NodeJS.ProcessEnv = process.env, platform = process.platform, plain = false): { kind: 'tmux-split' | 'tmux-new' | 'wt-split' | 'print'; argv?: string[]; message: string; cmd: string } {
  const cmd = `tally watch${plain ? ' --plain' : ''}`;
  if (env.TMUX && exists('tmux')) return { kind: 'tmux-split', argv: ['tmux', 'split-window', '-h', '-l', '45%', cmd], message: 'Opened the Coach pane in tmux. Start or continue your Claude Code session in the left pane.', cmd };
  if (platform !== 'win32' && exists('tmux')) return { kind: 'tmux-new', argv: ['tmux', 'new-session', '-d', '-s', 'tally', 'claude', ';', 'split-window', '-h', '-l', '45%', cmd, ';', 'select-pane', '-L'], message: 'Created tmux session "tally" with Claude Code on the left and the Coach on the right. Attach with: tmux attach -t tally', cmd };
  if (platform === 'win32' && env.WT_SESSION && exists('wt')) return { kind: 'wt-split', argv: ['wt', '-w', '0', 'split-pane', '-V', '--size', '0.45', 'cmd', '/k', cmd], message: 'Opened the Coach pane in Windows Terminal next to this one.', cmd };
  return { kind: 'print', message: `No tmux${platform === 'win32' ? ' or Windows Terminal split' : ''} available. Open a second terminal next to Claude Code and run:\n\n    ${cmd}\n\nIt attaches to the latest active session automatically.`, cmd };
}

export async function run(args: Args): Promise<void> {
  const plan = startPlan(process.env, process.platform, has(args, 'plain'));
  if (plan.argv) {
    const [bin, ...rest] = plan.argv;
    const r = spawnSync(bin!, rest, { stdio: 'inherit', windowsHide: false });
    if (r.status === 0) {
      process.stdout.write(plan.message + '\n');
      return;
    }
    process.stdout.write(`Could not open a split (${bin} exited ${r.status}). Run this in a second terminal:\n\n    ${plan.cmd}\n`);
    return;
  }
  process.stdout.write(plan.message + '\n');
}
