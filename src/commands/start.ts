import { spawnSync } from 'node:child_process';
import { type Args, has } from '../cli.js';

export async function run(args: Args): Promise<void> {
  const cmd = `tally watch${has(args, 'plain') ? ' --plain' : ''}`;
  if (process.env.TMUX) {
    const r = spawnSync('tmux', ['split-window', '-h', '-l', '45%', cmd], { stdio: 'inherit' });
    if (r.status === 0) {
      process.stdout.write('Opened the Coach pane in tmux. Start or continue your Claude Code session in the left pane.\n');
      return;
    }
  }
  const hasTmux = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['tmux'], { stdio: 'ignore' }).status === 0;
  if (hasTmux) {
    const r = spawnSync('tmux', ['new-session', '-d', '-s', 'tally', 'claude', ';', 'split-window', '-h', '-l', '45%', cmd, ';', 'select-pane', '-L'], { stdio: 'inherit' });
    if (r.status === 0) {
      process.stdout.write('Created tmux session "tally" with Claude Code on the left and the Coach on the right. Attach with: tmux attach -t tally\n');
      return;
    }
  }
  process.stdout.write(`No tmux available. Open a second terminal next to Claude Code and run:\n\n    ${cmd}\n\nIt attaches to the latest active session automatically.\n`);
}
