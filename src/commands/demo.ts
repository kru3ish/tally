import { type Args, has, flag } from '../cli.js';
import { runDemo } from '../demo/demo.js';

export async function run(args: Args): Promise<void> {
  await runDemo({ color: !has(args, 'plain'), keep: has(args, 'keep'), fast: has(args, 'fast'), width: flag(args, 'width') ? Number(flag(args, 'width')) : undefined });
}
