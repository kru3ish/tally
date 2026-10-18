/* `tally cost`: the cost check for the current session (or one named): estimate vs actual, where the money went, and
   the one-line fixes for the next similar story. A named session can be any past Claude Code session on this machine,
   recorded by Tally or not. */
import path from 'node:path';
import { type Args, flag, has } from '../cli.js';
import { resolveSession, transcriptPathFor } from '../session.js';
import { computeCheck, renderCheck } from '../estimate/variance.js';
import { listTranscripts } from '../backfill/scan.js';
import { loadConfig } from '../config.js';

function pastTranscript(prefix: string): { session: string; file: string } | undefined {
  const hits = listTranscripts().filter((f) => path.basename(f, '.jsonl').startsWith(prefix));
  if (hits.length !== 1) return undefined;
  return { session: path.basename(hits[0]!, '.jsonl'), file: hits[0]! };
}

export async function run(args: Args): Promise<number | void> {
  const given = flag(args, 'session') ?? args._[0];
  let session: string | undefined;
  let transcriptPath: string | undefined;
  try {
    session = resolveSession(given, process.cwd());
  } catch {
    session = undefined;
  }
  if (given && (!session || !transcriptPathFor(session))) {
    const past = pastTranscript(given);
    if (past) ({ session, file: transcriptPath } = { session: past.session, file: past.file });
  }
  if (!session) {
    process.stderr.write(given ? `No session or past transcript matches "${given}".\n` : 'No session found. Run this inside a Claude Code session, or pass a session id.\n');
    return 1;
  }
  const check = computeCheck(session, { transcriptPath, baselineTokens: loadConfig().baseline_context_tokens });
  if (has(args, 'json')) {
    process.stdout.write(JSON.stringify(check, null, 2) + '\n');
    return;
  }
  process.stdout.write(renderCheck(check) + '\n');
}
