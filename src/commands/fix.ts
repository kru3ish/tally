/* `tally fix <id>`: apply one fix from a cost check. Settings, subagents, skills and CLAUDE.md notes are written into
   the repo (commit them and the team has them; --global writes ~/.claude instead) and reverted by `tally undo`.
   An official plugin from Anthropic's marketplace is installed with `claude plugin install`, because you asked for
   it by running this; community tools and server removals are only printed. `tally fix all` applies every fix Tally
   writes itself. A command copied from the dashboard finds its cost check from the current folder. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { type Args, flag, has } from '../cli.js';
import { resolveSession, sessionCwd } from '../session.js';
import { applyFix, checkFile, computeCheck, findFix, loadCheck, type CostCheck, type Fix } from '../estimate/variance.js';
import { isOfficialInstall } from '../estimate/actions.js';
import { loadConfig } from '../config.js';
import { sessionsDir, repoKey } from '../paths.js';

/* the newest cost check for this folder that offers `id`, when the current session's does not */
function checkWithFix(id: string, cwd: string): CostCheck | null {
  const root = sessionsDir();
  if (!fs.existsSync(root)) return null;
  const here = repoKey(cwd);
  const found = fs
    .readdirSync(root)
    .map((s) => path.join(root, s, 'cost-check.json'))
    .filter((f) => fs.existsSync(f))
    .map((f) => ({ f, t: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { f } of found) {
    try {
      const c = JSON.parse(fs.readFileSync(f, 'utf8')) as CostCheck;
      if (c.cwd && repoKey(c.cwd) !== here && !here.startsWith(repoKey(c.cwd))) continue;
      if (id === 'all' || findFix(c, id)) return c;
    } catch {
      /* skip */
    }
  }
  return null;
}

function runOfficial(fix: Fix): { ok: boolean; detail: string } {
  const cmds = (fix.apply as { commands: string[] }).commands;
  for (const c of cmds) {
    const [bin, ...argv] = c.split(' ');
    process.stdout.write(`$ ${c}\n`);
    const r = spawnSync(bin!, argv, { stdio: 'inherit', windowsHide: true, shell: process.platform === 'win32' });
    if (r.status !== 0) return { ok: false, detail: `\`${c}\` failed${r.error ? `: ${r.error.message}` : ''}` };
  }
  return { ok: true, detail: 'installed; it loads in the next session' };
}

function applyOne(fix: Fix, session: string, cwd: string, global: boolean): boolean {
  if (isOfficialInstall(fix)) {
    const r = runOfficial(fix);
    process.stdout.write(`${r.ok ? '✓' : '✗'} ${fix.title}: ${r.detail}\n`);
    return r.ok;
  }
  const r = applyFix(fix, { session, cwd, global });
  process.stdout.write(`${r.ok ? '✓' : '·'} ${fix.title}: ${r.detail}\n`);
  return r.ok;
}

export async function run(args: Args): Promise<number | void> {
  const id = args._[0];
  let session: string | undefined;
  try {
    session = resolveSession(flag(args, 'session'), process.cwd());
  } catch {
    session = undefined;
  }
  let check = session ? loadCheck(session) : null;
  if (id && id !== '--list' && (!check || (id !== 'all' && !findFix(check, id)))) check = checkWithFix(id, process.cwd()) ?? check;
  if (!check && session) check = computeCheck(session, { baselineTokens: loadConfig().baseline_context_tokens });
  if (!check) {
    process.stderr.write('No cost check found here. Run `tally cost` (or /tally:cost) first.\n');
    return 1;
  }
  session = check.session;
  const fixes = [...new Map(check.drivers.filter((d) => d.fix).map((d) => [d.fix!.id, d.fix!])).values()];
  if (!id || has(args, 'list')) {
    if (!fixes.length) process.stdout.write('No fixes suggested for this session. Run `tally cost` for the breakdown.\n');
    for (const f of fixes) process.stdout.write(`${f.id.padEnd(18)} ${f.title}: ${f.what}\n`);
    return id ? 0 : fixes.length ? 0 : 1;
  }
  const cwd = sessionCwd(session) ?? check.cwd ?? process.cwd();
  if (id === 'all') {
    /* everything Tally writes itself; plugin installs stay one at a time, since each adds tools to every session */
    const own = fixes.filter((f) => f.apply.kind === 'settings' || f.apply.kind === 'file' || f.apply.kind === 'claude_md');
    if (!own.length) {
      process.stdout.write('Nothing for Tally to apply here; the remaining suggestions are installs or habits (`tally cost`).\n');
      return 0;
    }
    let ok = 0;
    for (const f of own) if (applyOne(f, session, cwd, has(args, 'global'))) ok += 1;
    process.stdout.write(`\n${ok}/${own.length} applied. They take effect in the next session; \`tally undo ${ok}\` reverts them.\n`);
    return ok === own.length ? 0 : 1;
  }
  const fix = findFix(check, id);
  if (!fix) {
    process.stderr.write(`No fix "${id}" here. Available: ${fixes.map((f) => f.id).join(', ') || 'none'}, or all\n`);
    return 1;
  }
  const ok = applyOne(fix, session, cwd, has(args, 'global'));
  if (ok && !isOfficialInstall(fix) && fix.apply.kind !== 'command' && fix.apply.kind !== 'advice') process.stdout.write('Takes effect in the next session. Revert with: tally undo\n');
  void checkFile;
  return ok ? 0 : 1;
}
