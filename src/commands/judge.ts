import fs from 'node:fs';
import path from 'node:path';
import { type Args, flag, has } from '../cli.js';
import { loadConfig } from '../config.js';
import { makeLlm } from '../llm/client.js';
import { judgeSession, existingReceiptFor, renderSummary, recomputeReceipt } from '../judge/judge.js';
import { writeBack } from '../judge/writeback.js';
import { resolveSession, sessionCwd, transcriptPathFor } from '../session.js';
import { sessionDir, log } from '../paths.js';
import type { Judge } from '../judge/schema.js';
import { testRerunConsent, setTestRerunConsent } from '../config.js';
import { detectTestCommand } from '../judge/verify.js';
import readline from 'node:readline';

function askYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

export async function run(args: Args): Promise<number | void> {
  const cfg = loadConfig();
  const session = resolveSession(args._[0] ?? flag(args, 'session'), process.cwd());
  if (!session) {
    process.stderr.write('No session found. Pass a session id or run inside a tracked repo.\n');
    return 1;
  }
  const auto = has(args, 'auto');
  const reasonFlag = flag(args, 'reason');
  const reason = (['push', 'pr', 'merge', 'publish', 'session_end', 'manual'].includes(reasonFlag ?? '') ? reasonFlag : auto ? 'session_end' : 'manual') as Judge['reason'];
  const cwd = sessionCwd(session) ?? process.cwd();
  if (has(args, 'recompute')) {
    /* re-derive completion and verdict from the stored criteria (no model call); used after a scoring-rule change */
    const j = recomputeReceipt(session);
    if (!j) {
      process.stderr.write(`No receipt for session ${session}.\n`);
      return 1;
    }
    process.stdout.write(renderSummary(j, !has(args, 'plain')) + '\n');
    return;
  }
  const existing = existingReceiptFor(session, cwd);
  if (existing && !has(args, 'force') && !has(args, 'deep')) {
    log(`judge: ${session} already judged at HEAD ${existing.head?.slice(0, 8) ?? '?'} (${existing.reason}); reusing`);
    if (!auto) {
      process.stdout.write(`Receipt already exists for this HEAD (judged on ${existing.reason}); showing it. Use --force to re-judge or --deep for the strong model.\n`);
      process.stdout.write(renderSummary(existing, !has(args, 'plain')) + '\n');
    }
    return;
  }
  const transcriptPath = flag(args, 'transcript') ?? transcriptPathFor(session);
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    if (!auto) process.stderr.write(`No transcript found for session ${session}.\n`);
    return 1;
  }
  const lock = path.join(sessionDir(session), 'judge.lock');
  if (fs.existsSync(lock) && Date.now() - fs.statSync(lock).mtimeMs < 10 * 60 * 1000) {
    if (!auto) process.stderr.write('A judge run is already in progress for this session.\n');
    return 1;
  }
  fs.writeFileSync(lock, String(process.pid));
  try {
    const llm = makeLlm({ session });
    if (!auto) process.stdout.write(`Judging session ${session} (${reason})…\n`);
    let consent = testRerunConsent(cfg, cwd);
    if (consent === undefined && !auto && process.stdin.isTTY && cfg.judge.run_tests) {
      const detected = detectTestCommand(cwd);
      if (detected) {
        consent = await askYesNo(`Tally verifies claims by running \`${detected.command}\` itself in ${cwd} (scrubbed environment, ${Math.round(cfg.judge.test_timeout_ms / 1000)}s timeout). Allow this for this repo? [y/N] `);
        setTestRerunConsent(cwd, consent);
        process.stdout.write(consent ? 'Saved: test re-runs allowed for this repo (tally config consent.test_rerun.<repo> false to revoke).\n' : 'Saved: tests will not be run here; test criteria will be marked unverifiable.\n');
      }
    }
    const judge = await judgeSession({ session, cwd, transcriptPath, cfg, llm, reason, consent, deep: has(args, 'deep') });
    const plain = has(args, 'plain');
    process.stdout.write(renderSummary(judge, !plain) + '\n');
    process.stdout.write(`Receipt: ${path.join(sessionDir(session), 'report.md')}\n`);
    if (has(args, 'post') || cfg.writeback) {
      const r = await writeBack(judge, cfg);
      for (const p of r.posted) process.stdout.write(`${p.ok ? 'Posted' : 'Failed to post'} receipt to ${p.target}${p.detail ? ` (${p.detail})` : ''}\n`);
      if (!r.posted.length) process.stdout.write('Nothing to post to: no issue or PR URL is linked to this session.\n');
    }
  } finally {
    if (fs.existsSync(lock)) fs.unlinkSync(lock);
  }
}
