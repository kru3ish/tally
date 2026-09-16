import { type Args, has } from '../cli.js';
import { readUndoLog, undoLast } from '../coach/undo.js';

export async function run(args: Args): Promise<void> {
  if (has(args, 'list')) {
    const entries = readUndoLog().reverse().slice(0, 20);
    if (!entries.length) {
      process.stdout.write('Nothing to undo.\n');
      return;
    }
    for (const e of entries) process.stdout.write(`${e.undone ? '(undone) ' : ''}${e.ts}  ${e.rule}  ${e.label}  ${e.file}\n`);
    return;
  }
  const n = Math.max(1, Number(args._[0] ?? 1) || 1);
  const done = undoLast(n);
  if (!done.length) {
    process.stdout.write('Nothing to undo.\n');
    return;
  }
  for (const e of done) process.stdout.write(`Reverted ${e.label} (${e.file})${e.before === null ? ' — file removed' : ''}\n`);
}
