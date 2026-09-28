/* `tally onboard [--since 30d] [--budget 60] [--json]`: the honest first result the moment Tally is installed, from the
   transcripts already on disk and no model calls. It says what Tally can and cannot reconstruct from history (counts,
   not claims), shows at most three concrete findings each labelled with its confidence and the reason, keeps the spend
   and waste report, and ends with one next command. Retrospective work never produces VERIFIED: that needs a live session
   with an independent test run at the time; history can support UNVERIFIED, UNMET, or "cannot reconstruct". */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { type Args, flag, has } from '../cli.js';
import { scanSessions, type SessionCandidate } from '../backfill/scan.js';
import { detectTaskLink } from '../backfill/link.js';
import { parseTranscriptFile, type Transcript } from '../transcript/parse.js';
import { fmtUsd, loadPricing } from '../cost/pricing.js';
import { readRateLimits } from '../coach/rules/rate-limit.js';

export interface OnboardFinding {
  text: string;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  session?: string;
}

export interface OnboardReport {
  since: string;
  sessions: number;
  spend_usd: number;
  days: number;
  /* what history supports, as counts; the reader decides what to do with each bucket */
  reconstruction: {
    found: number;
    scanned: number;
    analysable: number;
    with_task: number;
    partially_verifiable: number;
    /* transcript unparseable or empty: nothing can be said about the session */
    unreconstructable: number;
    /* analysable, but the working directory no longer exists: no diff, no tests, transcript facts only */
    repo_missing: number;
    truncated_after_s?: number;
  };
  findings: OnboardFinding[];
  top: Array<{ session: string; cost: number; repo: string; prompt: string }>;
  waste: { loops_usd: number; loops: number; rereads_usd: number; rereads: number; compactions: number; first_turn_avg: number };
  habit: string;
  plans: Array<{ name: string; usd_month: number; note: string }> | null;
  limit_hits: number;
  next: { command: string; why: string };
  elapsed_ms: number;
}

function shortRepo(repo?: string): string {
  return (repo ?? '?').split('/').slice(-2).join('/');
}

export const TEST_CMD_RE = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\b(vitest|jest|mocha|pytest|py\.test|go test|cargo test|rspec|phpunit|dotnet test|gradle test|mvn (-q )?test|make test|tape|ava|node --test)\b/;
export const CLAIM_RE = /\b(all )?tests? (are |is )?(now )?(pass|passing|passes|green)\b|\btest suite (passes|is green)\b|\bready to (merge|ship)\b/i;

function isGitRepo(cwd?: string): boolean {
  if (!cwd || !fs.existsSync(cwd)) return false;
  const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, encoding: 'utf8', windowsHide: true, timeout: 5000 });
  return r.status === 0 && r.stdout.trim() === 'true';
}

function commitsBetween(cwd: string, start?: string, end?: string): number | null {
  if (!start || !end) return null;
  const r = spawnSync('git', ['rev-list', '--count', '--all', `--since=${start}`, `--until=${end}`], { cwd, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  return r.status === 0 ? Number(r.stdout.trim()) || 0 : null;
}

export function buildOnboard(since = '30d', now = Date.now(), opts: { budgetMs?: number; progress?: (s: string) => void } = {}): OnboardReport {
  const t0 = Date.now();
  const budget = opts.budgetMs ?? 60000;
  const cands = scanSessions({ since, now }).slice().sort((a, b) => b.mtime - a.mtime);
  let spend = 0;
  let loops = 0;
  let loopsUsd = 0;
  let rereads = 0;
  let rereadsUsd = 0;
  let compactions = 0;
  let firstTurnSum = 0;
  let firstTurnN = 0;
  let limitHits = 0;
  const top: OnboardReport['top'] = [];
  const rec = { found: cands.length, scanned: 0, analysable: 0, with_task: 0, partially_verifiable: 0, unreconstructable: 0, repo_missing: 0 } as OnboardReport['reconstruction'];
  const claimsWithoutRun: Array<{ c: SessionCandidate; claim: string }> = [];
  const loopSessions: Array<{ c: SessionCandidate; cmd: string; n: number }> = [];
  const verifiable: Array<{ c: SessionCandidate; ref: string; commits: number }> = [];
  for (const c of cands) {
    if (Date.now() - t0 >= budget) {
      rec.truncated_after_s = Math.round(budget / 1000);
      break;
    }
    rec.scanned += 1;
    if (opts.progress && rec.scanned % 25 === 0) opts.progress(`scanning ${rec.scanned}/${cands.length}…`);
    let t: Transcript;
    try {
      t = parseTranscriptFile(c.transcript);
    } catch {
      rec.unreconstructable += 1;
      continue;
    }
    if (t.internal) {
      rec.found -= 1;
      rec.scanned -= 1;
      continue;
    }
    if (!t.toolCalls.length && !t.messages.length) {
      rec.unreconstructable += 1;
      continue;
    }
    rec.analysable += 1;
    spend += t.cost;
    top.push({ session: c.session, cost: t.cost, repo: shortRepo(c.repo), prompt: (c.first_prompt || '').replace(/\s+/g, ' ').slice(0, 70) });
    compactions += t.compactions.length;
    if (t.firstTurnContextTokens) {
      firstTurnSum += t.firstTurnContextTokens;
      firstTurnN += 1;
    }
    const avgTurn = t.messages.length ? t.cost / t.messages.length : 0;
    /* loops: the same Bash command failing 3+ times in a row */
    const fails = new Map<string, number>();
    for (const call of t.toolCalls) {
      if (call.name === 'Bash' && call.result?.isError) {
        const k = String(call.input.command ?? '').slice(0, 120);
        fails.set(k, (fails.get(k) ?? 0) + 1);
      }
    }
    for (const [cmd, n] of fails) if (n >= 3) {
      loops += 1;
      loopsUsd += (n - 1) * avgTurn;
      loopSessions.push({ c, cmd, n });
    }
    /* re-reads: the same file read 3+ times */
    const reads = new Map<string, number>();
    for (const call of t.toolCalls) if (call.name === 'Read' && typeof call.input.file_path === 'string') reads.set(call.input.file_path, (reads.get(call.input.file_path) ?? 0) + 1);
    for (const n of reads.values()) if (n >= 3) {
      rereads += 1;
      rereadsUsd += (n - 1) * avgTurn * 0.5;
    }
    /* a "tests pass" claim in the final message with no test command anywhere in the transcript: a claim, not evidence */
    const claim = CLAIM_RE.exec(t.finalAssistantText ?? '');
    if (claim && !t.toolCalls.some((call) => call.name === 'Bash' && TEST_CMD_RE.test(String(call.input.command ?? '')))) claimsWithoutRun.push({ c, claim: claim[0] });
    /* task identifiable from the prompts, the branch or the commits in the window */
    const link = detectTaskLink({ cwd: c.cwd, branch: c.branch, prompts: c.prompts, start: c.started, end: c.ended });
    const hasTask = link.kind !== 'none' && link.confidence >= 0.5;
    if (hasTask) rec.with_task += 1;
    /* partial retrospective verification: the repository is still there and has commits from the session's window */
    if (isGitRepo(c.cwd)) {
      const commits = commitsBetween(c.cwd!, c.started, c.ended);
      if (commits && commits > 0) {
        rec.partially_verifiable += 1;
        if (hasTask) verifiable.push({ c, ref: link.ref, commits });
      }
    } else if (!c.cwd || !fs.existsSync(c.cwd)) rec.repo_missing += 1;
    const rl = readRateLimits(c.session);
    if (rl && Math.max(rl.five_hour?.used_percentage ?? 0, rl.seven_day?.used_percentage ?? 0) >= 95) limitHits += 1;
  }
  top.sort((a, b) => b.cost - a.cost);
  const firstTurnAvg = firstTurnN ? Math.round(firstTurnSum / firstTurnN) : 0;
  const pricing = loadPricing() as { plans?: Record<string, { usd_month: number; note: string }>; baseline_context_tokens?: number };
  const deadWeightUsd = firstTurnAvg > 20000 ? (rec.analysable * Math.max(0, firstTurnAvg - 15000) * 3) / 1e6 : 0;
  const candidates = [
    { usd: loopsUsd, text: `Stop retrying a failing command after the second identical failure: ${loops} loop(s) cost about ${fmtUsd(loopsUsd)}.` },
    { usd: rereadsUsd, text: `Keep notes instead of re-reading files: ${rereads} file(s) were read three or more times, about ${fmtUsd(rereadsUsd)}.` },
    { usd: deadWeightUsd, text: `Trim the first turn: sessions start with ${firstTurnAvg.toLocaleString('en-US')} tokens of context on average; every unused skill or MCP server is paid for on every turn (~${fmtUsd(deadWeightUsd)}).` },
    { usd: compactions * 0.5, text: `${compactions} compaction(s): write a HANDOFF.md before context fills so the re-cache is cheap and nothing is lost.` },
  ].sort((a, b) => b.usd - a.usd);
  const days = since.endsWith('d') ? Number(since.slice(0, -1)) : 30;
  const monthly = days ? (spend / days) * 30 : spend;
  const plans = pricing.plans ? Object.entries(pricing.plans).map(([name, p]) => ({ name, usd_month: p.usd_month, note: p.note })) : null;

  /* findings: at most three, concrete, each with its confidence and the reason for that confidence */
  const findings: OnboardFinding[] = [];
  if (claimsWithoutRun.length) {
    const f = claimsWithoutRun[0]!;
    findings.push({
      text: `${claimsWithoutRun.length} session(s) ended with "${f.claim}" and no test command ran in the transcript (first: ${f.c.session.slice(0, 8)}, ${shortRepo(f.c.repo)}).`,
      confidence: 'high',
      reason: 'the transcript records every command the agent ran; none matched a test runner',
      session: f.c.session,
    });
  }
  if (loopSessions.length) {
    const f = loopSessions.sort((a, b) => b.n - a.n)[0]!;
    findings.push({ text: `Session ${f.c.session.slice(0, 8)} ran the same failing command ${f.n} times: ${f.cmd.slice(0, 60)}${f.cmd.length > 60 ? '…' : ''}.`, confidence: 'high', reason: 'identical Bash command with an error result, counted from the transcript', session: f.c.session });
  }
  if (verifiable.length) {
    const f = verifiable[0]!;
    findings.push({ text: `Session ${f.c.session.slice(0, 8)} worked on ${f.ref} and the repository still holds ${f.commits} commit(s) from that window; a retrospective receipt is possible (UNVERIFIED or UNMET at most, never VERIFIED).`, confidence: 'medium', reason: 'the task link comes from the prompts or commit messages; tests from that time may not run', session: f.c.session });
  }
  if (findings.length < 3 && firstTurnAvg > 40000) findings.push({ text: `Sessions start with ${firstTurnAvg.toLocaleString('en-US')} tokens of context before any work; that is paid on every turn.`, confidence: 'medium', reason: 'averaged from the first assistant turn of each transcript; the split between instructions, skills and MCP is not visible here' });

  const next = verifiable.length
    ? { command: `tally backfill add ${verifiable[0]!.c.session.slice(0, 8)}`, why: `a retrospective receipt for ${verifiable[0]!.ref}; statuses from history are UNVERIFIED or UNMET at most, never VERIFIED` }
    : { command: 'tally task "<what you are about to ask the agent to do>"', why: 'freeze the acceptance criteria before the next real task, then `tally verify` when the agent says done' };
  return {
    since,
    sessions: rec.found,
    spend_usd: spend,
    days,
    reconstruction: rec,
    findings: findings.slice(0, 3),
    top: top.slice(0, 3),
    waste: { loops_usd: loopsUsd, loops, rereads_usd: rereadsUsd, rereads, compactions, first_turn_avg: firstTurnAvg },
    habit: candidates[0]!.usd > 0 ? candidates[0]!.text : 'No loops, re-reads or heavy first turns found; the habits look clean.',
    plans,
    limit_hits: limitHits,
    next,
    elapsed_ms: Date.now() - t0,
  };
}

export function renderOnboard(r: OnboardReport): string {
  const L: string[] = [];
  const monthly = r.days ? (r.spend_usd / r.days) * 30 : r.spend_usd;
  const rec = r.reconstruction;
  L.push(`Tally · your last ${r.since}: ${r.sessions} session(s), ${fmtUsd(r.spend_usd)} API-equivalent (≈ ${fmtUsd(monthly)}/month)`);
  L.push('');
  L.push('What history supports (read locally, nothing sent anywhere)');
  L.push(`  sessions found                         ${String(rec.found).padStart(5)}${rec.truncated_after_s !== undefined ? `   (${rec.scanned} scanned in ${rec.truncated_after_s}s; --budget for more)` : ''}`);
  L.push(`  with enough information to analyse     ${String(rec.analysable).padStart(5)}`);
  L.push(`  with an identifiable task              ${String(rec.with_task).padStart(5)}   (issue, ticket or PR in the prompts or commits)`);
  L.push(`  partial retrospective verification     ${String(rec.partially_verifiable).padStart(5)}   (repository still present with commits from the window)`);
  L.push(`  cannot be reconstructed                ${String(rec.unreconstructable).padStart(5)}   (unparseable or empty transcript)`);
  L.push(`  directory gone, transcript only        ${String(rec.repo_missing).padStart(5)}   (no diff or tests can be re-derived)`);
  L.push('  A retrospective check can say UNVERIFIED or UNMET. VERIFIED needs a live session with an independent test run.');
  L.push('');
  if (r.findings.length) {
    L.push('Findings');
    for (const f of r.findings) L.push(`  [${f.confidence}] ${f.text}\n           why ${f.confidence}: ${f.reason}`);
    L.push('');
  }
  if (r.top.length) {
    L.push('Most expensive sessions');
    for (const t of r.top) L.push(`  ${fmtUsd(t.cost).padStart(9)}  ${t.session.slice(0, 8)}  ${t.repo.padEnd(26).slice(0, 26)}  ${t.prompt}`);
    L.push('');
  }
  L.push('Where money went that bought nothing');
  L.push(`  retry loops       ${fmtUsd(r.waste.loops_usd).padStart(9)}  (${r.waste.loops} command(s) failed 3+ times in a row)`);
  L.push(`  repeated reads    ${fmtUsd(r.waste.rereads_usd).padStart(9)}  (${r.waste.rereads} file(s) read 3+ times)`);
  L.push(`  first-turn load   ${String(r.waste.first_turn_avg.toLocaleString('en-US')).padStart(9)}  tokens on average before the first word of work`);
  L.push(`  compactions       ${String(r.waste.compactions).padStart(9)}`);
  L.push('');
  L.push(`One habit that would have saved the most: ${r.habit}`);
  if (r.plans) {
    L.push('');
    L.push(`At list price this usage is ≈ ${fmtUsd(monthly)}/month through the API. Plans (prices from pricing.json; check the current page):`);
    for (const p of r.plans) L.push(`  ${p.name.padEnd(10)} $${p.usd_month}/month  ${p.note}${monthly > p.usd_month ? '  ← cheaper than API at your volume' : ''}`);
    if (r.limit_hits) L.push(`  You reached a usage limit in ${r.limit_hits} session(s); the waste above is the first thing to fix before moving up a tier.`);
  }
  L.push('');
  L.push(`Next: ${r.next.command}   (${r.next.why})`);
  L.push(`Took ${(r.elapsed_ms / 1000).toFixed(1)}s.`);
  return L.join('\n');
}

export async function run(args: Args): Promise<number | void> {
  const budget = flag(args, 'budget') ? Number(flag(args, 'budget')) * 1000 : 60000;
  const progress = process.stderr.isTTY && !has(args, 'json') ? (s: string) => process.stderr.write(`\r${s}`) : undefined;
  const r = buildOnboard(flag(args, 'since') ?? '30d', Date.now(), { budgetMs: budget, progress });
  if (progress) process.stderr.write('\r' + ' '.repeat(40) + '\r');
  if (has(args, 'json')) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  else process.stdout.write(renderOnboard(r) + '\n');
}
