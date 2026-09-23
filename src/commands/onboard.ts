/* `tally onboard [--since 30d]`: the one-page personal report the moment Tally is installed, from the transcripts already
   on disk and no model calls: total spend, the biggest sessions, the waste patterns that cost the most, one habit that
   would have saved the most, and what the same usage would cost on each Claude plan at list price. */
import { type Args, flag, has } from '../cli.js';
import { scanSessions } from '../backfill/scan.js';
import { parseTranscriptFile } from '../transcript/parse.js';
import { fmtUsd, loadPricing } from '../cost/pricing.js';
import { readRateLimits } from '../coach/rules/rate-limit.js';

export interface OnboardReport {
  since: string;
  sessions: number;
  spend_usd: number;
  days: number;
  top: Array<{ session: string; cost: number; repo: string; prompt: string }>;
  waste: { loops_usd: number; loops: number; rereads_usd: number; rereads: number; compactions: number; first_turn_avg: number };
  habit: string;
  plans: Array<{ name: string; usd_month: number; note: string }> | null;
  limit_hits: number;
}

function shortRepo(repo?: string): string {
  return (repo ?? '?').split('/').slice(-2).join('/');
}

export function buildOnboard(since = '30d', now = Date.now()): OnboardReport {
  const cands = scanSessions({ since, now });
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
  for (const c of cands) {
    let t;
    try {
      t = parseTranscriptFile(c.transcript);
    } catch {
      continue;
    }
    if (t.internal) continue;
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
    for (const n of fails.values()) if (n >= 3) {
      loops += 1;
      loopsUsd += (n - 1) * avgTurn;
    }
    /* re-reads: the same file read 3+ times */
    const reads = new Map<string, number>();
    for (const call of t.toolCalls) if (call.name === 'Read' && typeof call.input.file_path === 'string') reads.set(call.input.file_path, (reads.get(call.input.file_path) ?? 0) + 1);
    for (const n of reads.values()) if (n >= 3) {
      rereads += 1;
      rereadsUsd += (n - 1) * avgTurn * 0.5;
    }
    const rl = readRateLimits(c.session);
    if (rl && Math.max(rl.five_hour?.used_percentage ?? 0, rl.seven_day?.used_percentage ?? 0) >= 95) limitHits += 1;
  }
  top.sort((a, b) => b.cost - a.cost);
  const firstTurnAvg = firstTurnN ? Math.round(firstTurnSum / firstTurnN) : 0;
  const pricing = loadPricing() as { plans?: Record<string, { usd_month: number; note: string }>; baseline_context_tokens?: number };
  const deadWeightUsd = firstTurnAvg > 20000 ? (cands.length * Math.max(0, firstTurnAvg - 15000) * 3) / 1e6 : 0;
  const candidates = [
    { usd: loopsUsd, text: `Stop retrying a failing command after the second identical failure: ${loops} loop(s) cost about ${fmtUsd(loopsUsd)}.` },
    { usd: rereadsUsd, text: `Keep notes instead of re-reading files: ${rereads} file(s) were read three or more times, about ${fmtUsd(rereadsUsd)}.` },
    { usd: deadWeightUsd, text: `Trim the first turn: sessions start with ${firstTurnAvg.toLocaleString('en-US')} tokens of context on average; every unused skill or MCP server is paid for on every turn (~${fmtUsd(deadWeightUsd)}).` },
    { usd: compactions * 0.5, text: `${compactions} compaction(s): write a HANDOFF.md before context fills so the re-cache is cheap and nothing is lost.` },
  ].sort((a, b) => b.usd - a.usd);
  const days = since.endsWith('d') ? Number(since.slice(0, -1)) : 30;
  const monthly = days ? (spend / days) * 30 : spend;
  const plans = pricing.plans ? Object.entries(pricing.plans).map(([name, p]) => ({ name, usd_month: p.usd_month, note: p.note })) : null;
  return { since, sessions: cands.length, spend_usd: spend, days, top: top.slice(0, 3), waste: { loops_usd: loopsUsd, loops, rereads_usd: rereadsUsd, rereads, compactions, first_turn_avg: firstTurnAvg }, habit: candidates[0]!.usd > 0 ? candidates[0]!.text : 'No loops, re-reads or heavy first turns found; the habits look clean.', plans, limit_hits: limitHits };
}

export function renderOnboard(r: OnboardReport): string {
  const L: string[] = [];
  const monthly = r.days ? (r.spend_usd / r.days) * 30 : r.spend_usd;
  L.push(`Tally · your last ${r.since}: ${r.sessions} session(s), ${fmtUsd(r.spend_usd)} API-equivalent (≈ ${fmtUsd(monthly)}/month)`);
  L.push('');
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
  L.push('Next: tally backfill list --suggest 5   (receipts for the sessions above, then tally calibrate grade to check the Judge on your own work)');
  return L.join('\n');
}

export async function run(args: Args): Promise<number | void> {
  const r = buildOnboard(flag(args, 'since') ?? '30d');
  if (has(args, 'json')) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  else process.stdout.write(renderOnboard(r) + '\n');
}
