/* `tally verify [session] [--json] [--ci] [--deep] [--fresh] [--no-evidence]`: what can Tally prove about this task?

   Uses the session's receipt (judging first when there is none, or when --deep / --fresh asks), builds the Evidence Map
   and prints the four statuses with the evidence under each. --json emits the `tally.verify.v1` document; --ci prints
   the compact form and exits 1 when any criterion is UNMET (2 when there is no task contract at all). */
import fs from 'node:fs';
import path from 'node:path';
import { type Args, has } from '../cli.js';
import { loadConfig, testRerunConsent } from '../config.js';
import { makeLlm } from '../llm/client.js';
import { judgeSession, loadJudge, currentHead } from '../judge/judge.js';
import { loadTask } from '../task/intake.js';
import { resolveSession, transcriptPathFor } from '../session.js';
import { readEvents } from '../store/events.js';
import { sessionDir, log } from '../paths.js';
import { buildAssurance, renderVerify, type Assurance } from '../assurance/index.js';
import { resolveSessionPrefix } from './dispute.js';
import { countVerification, shouldAskUsefulness, askUsefulness } from '../feedback/prompt.js';
import { record } from '../telemetry/index.js';
import type { AgentIdentity } from '../core/events.js';

export function agentOfSession(session: string): AgentIdentity {
  const start = readEvents(session).find((e) => e.type === 'session_start');
  return { product: String(start?.data.agent ?? 'claude-code'), version: typeof start?.data.version === 'string' ? start.data.version : undefined };
}

export async function verifySession(session: string, opts: { cwd: string; deep?: boolean; fresh?: boolean; quiet?: boolean }): Promise<Assurance | null> {
  const cfg = loadConfig();
  const task = loadTask(session);
  let judge = loadJudge(session);
  /* the repository is the one the receipt was made in, not wherever verify is run from; a receipt whose repository is
     gone (an evaluation worktree, a deleted clone) is shown as stored and never re-judged against another tree */
  const recorded = judge?.cwd;
  const repoGone = !!recorded && !fs.existsSync(recorded);
  if (recorded && !repoGone && path.resolve(recorded) !== path.resolve(opts.cwd)) {
    if (!opts.quiet) process.stderr.write(`Using the receipt's repository ${recorded} (verify was run from ${opts.cwd}).\n`);
    opts = { ...opts, cwd: recorded };
  }
  if (repoGone && !opts.quiet) process.stderr.write(`The receipt's repository ${recorded} no longer exists; showing the stored receipt without re-scanning a tree.\n`);
  const head = repoGone ? null : currentHead(opts.cwd);
  const stale = !!judge && !!head && !!judge.head && judge.head !== head;
  if (!repoGone && (!judge || stale || opts.deep || opts.fresh)) {
    const transcriptPath = transcriptPathFor(session);
    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      if (judge) log(`verify: ${session} no transcript; using the stored receipt`);
      else return null;
    } else {
      const lock = path.join(sessionDir(session), 'judge.lock');
      if (fs.existsSync(lock) && Date.now() - fs.statSync(lock).mtimeMs < 10 * 60 * 1000) {
        if (!opts.quiet) process.stderr.write('A judge run is in progress for this session; showing the stored receipt.\n');
      } else {
        fs.writeFileSync(lock, String(process.pid));
        try {
          if (!opts.quiet) process.stderr.write(`${judge ? (stale ? 'HEAD moved since the receipt; re-judging' : 'Re-judging') : 'No receipt yet; judging'} session ${session.slice(0, 8)}${opts.deep ? ' (deep)' : ''}…\n`);
          judge = await judgeSession({ session, cwd: opts.cwd, transcriptPath, cfg, llm: makeLlm({ session }), reason: 'manual', consent: testRerunConsent(cfg, opts.cwd), deep: opts.deep });
        } finally {
          fs.rmSync(lock, { force: true });
        }
      }
    }
  }
  if (!judge) return null;
  return buildAssurance({ judge, task, cwd: opts.cwd, agent: agentOfSession(session) });
}

export async function run(args: Args): Promise<number | void> {
  const cwd = process.cwd();
  const arg = args._[0];
  const session = arg ? resolveSessionPrefix(arg) : resolveSession(undefined, cwd);
  if (!session) {
    process.stderr.write('No session found. Pass a session id, or run from a repository with a Tally session.\n');
    return 2;
  }
  const ci = has(args, 'ci');
  const a = await verifySession(session, { cwd, deep: has(args, 'deep'), fresh: has(args, 'fresh'), quiet: has(args, 'json') });
  if (!a) {
    process.stderr.write(`Nothing to verify for session ${session.slice(0, 8)}: no receipt and no transcript. Run the task under Tally, or \`tally backfill add ${session.slice(0, 8)}\`.\n`);
    return 2;
  }
  if (has(args, 'json')) {
    process.stdout.write(JSON.stringify(a, null, 2) + '\n');
  } else {
    process.stdout.write(renderVerify(a, { color: !ci && !has(args, 'plain'), evidence: !has(args, 'no-evidence') && !ci }) + '\n');
    /* the one-time usefulness question, after the fifth real verification, only in an interactive terminal */
    const state = countVerification(session);
    if (shouldAskUsefulness(state, { interactive: !!process.stdin.isTTY && !!process.stdout.isTTY, ci })) await askUsefulness();
    /* metrics (opt-in): counts and the verdict word, never the criteria */
    record({ command: 'verify', success: true, agent: a.agent.product as 'claude-code', criteria: { verified: a.summary.verified, supported: a.summary.supported, unverified: a.summary.unverified, unmet: a.summary.unmet }, verdict: a.experimental.verdict });
  }
  if (ci) {
    if (a.task.status === 'none') {
      process.stderr.write('tally verify --ci: no task contract for this session.\n');
      return 2;
    }
    if (a.summary.unmet > 0) {
      process.stderr.write(`tally verify --ci: ${a.summary.unmet} criterion${a.summary.unmet > 1 ? 'a' : ''} UNMET.\n`);
      return 1;
    }
  }
}
