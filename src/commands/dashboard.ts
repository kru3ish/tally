/* `tally dashboard`: the team's cost per story from the repo's ledger, with the current session's story on top when
   there is one. A self-contained HTML file in the temp directory, opened in the browser. */
import { type Args, flag, has } from '../cli.js';
import { resolveSession } from '../session.js';
import { loadCheck } from '../estimate/variance.js';
import { openDashboard } from '../estimate/story.js';
import { readLedger } from '../estimate/ledger.js';

export async function run(args: Args): Promise<number | void> {
  const cwd = process.cwd();
  let current;
  try {
    const session = resolveSession(flag(args, 'session'), cwd);
    current = session ? loadCheck(session) ?? undefined : undefined;
  } catch {
    current = undefined;
  }
  const r = openDashboard(cwd, { current, open: !has(args, 'no-open') });
  const n = readLedger(cwd).length;
  process.stdout.write(`${r.opened ? 'Opened' : 'Wrote'} ${r.file}\n${n} ${n === 1 ? 'story' : 'stories'} in the team ledger${current ? ', plus this session' : ''}.${n ? '' : ' Stories are recorded in .tally/ledger.jsonl when a session ends; commit it to share.'}\n`);
}
