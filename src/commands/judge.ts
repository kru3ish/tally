import fs from 'node:fs';
import path from 'node:path';
import { type Args, flag, has } from '../cli.js';
import { loadConfig } from '../config.js';
import { makeLlm } from '../llm/client.js';
import { judgeSession, loadJudge, renderSummary } from '../judge/judge.js';
import { writeBack } from '../judge/writeback.js';
import { resolveSession, sessionCwd, transcriptPathFor } from '../session.js';
import { sessionDir, log } from '../paths.js';
import type { Judge } from '../judge/schema.js';

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
  const existing = loadJudge(session);
  if (existing && auto && reason === 'session_end') {
    log(`judge: ${session} already judged, skipping session_end re-run`);
    return;
  }
  const cwd = sessionCwd(session) ?? process.cwd();
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
    const judge = await judgeSession({ session, cwd, transcriptPath, cfg, llm, reason });
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
