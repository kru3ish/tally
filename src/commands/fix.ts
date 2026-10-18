/* `tally fix <id>`: apply one fix from the session's cost check. Settings fixes go into the repo's
   .claude/settings.json (commit it and the team gets it) or, with --global, ~/.claude/settings.json. `tally undo`
   reverts the last one. */
import { type Args, flag, has } from '../cli.js';
import { resolveSession, sessionCwd } from '../session.js';
import { applyFix, computeCheck, findFix, loadCheck } from '../estimate/variance.js';
import { loadConfig } from '../config.js';

export async function run(args: Args): Promise<number | void> {
  const session = resolveSession(flag(args, 'session'), process.cwd());
  if (!session) {
    process.stderr.write('No session found. Run this inside a Claude Code session, or pass --session.\n');
    return 1;
  }
  const check = loadCheck(session) ?? computeCheck(session, { baselineTokens: loadConfig().baseline_context_tokens });
  const id = args._[0];
  const fixes = [...new Map(check.drivers.filter((d) => d.fix).map((d) => [d.fix!.id, d.fix!])).values()];
  if (!id || has(args, 'list')) {
    if (!fixes.length) process.stdout.write('No fixes suggested for this session. Run `tally cost` for the breakdown.\n');
    for (const f of fixes) process.stdout.write(`${f.id.padEnd(18)} ${f.title}: ${f.what}\n`);
    return id ? 0 : fixes.length ? 0 : 1;
  }
  const fix = findFix(check, id);
  if (!fix) {
    process.stderr.write(`No fix "${id}" for this session. Available: ${fixes.map((f) => f.id).join(', ') || 'none'}\n`);
    return 1;
  }
  const cwd = sessionCwd(session) ?? check.cwd ?? process.cwd();
  const r = applyFix(fix, { session, cwd, global: has(args, 'global') });
  process.stdout.write(`${r.ok ? '✓' : '·'} ${fix.title}: ${r.detail}\n${r.ok && r.file ? 'Takes effect in the next session. Revert with: tally undo\n' : ''}`);
  return r.ok ? 0 : 1;
}
