import fs from 'node:fs';
import path from 'node:path';
import { type Args, flag, has } from '../cli.js';
import { loadConfig, testRerunConsent } from '../config.js';
import { makeLlm } from '../llm/client.js';
import { scanSessions, type SessionCandidate } from '../backfill/scan.js';
import { detectTaskLink } from '../backfill/link.js';
import { backfillSession, projectCost, isBackfilled, backfillSpendSince } from '../backfill/run.js';
import { fmtUsd } from '../cost/pricing.js';
import { sessionDir } from '../paths.js';

function shortRepo(repo?: string): string {
  if (!repo) return '?';
  const parts = repo.split('/');
  return parts.slice(-2).join('/');
}

export async function run(args: Args): Promise<number | void> {
  const cfg = loadConfig();
  const sub = args._[0] ?? 'list';
  const since = flag(args, 'since') ?? '60d';
  const repo = flag(args, 'repo');
  const plain = has(args, 'plain');

  if (sub === 'list' && flag(args, 'suggest')) {
    /* ranked shortlist for calibration: concrete, expensive sessions that edited files; no verdicts are shown here */
    const n = Math.max(1, Number(flag(args, 'suggest')) || 20);
    const cands = scanSessions({ since, repo }).filter((c) => c.cwd && fs.existsSync(c.cwd) && c.cost >= 0.2);
    const scored = cands.map((c) => {
      const link = detectTaskLink({ cwd: c.cwd, branch: c.branch, prompts: c.prompts, start: c.started, end: c.ended });
      const why: string[] = [];
      let score = c.cost;
      if (c.files_edited.length) why.push(`${c.files_edited.length} file(s) edited`);
      else score *= 0.25;
      if (link.kind !== 'none') {
        score *= 1.3;
        why.push(`link ${link.kind} ${link.confidence.toFixed(1)}`);
      } else why.push('task inferred from prompts');
      if (c.first_prompt.trim().length < 40) score *= 0.5;
      else why.push('concrete first prompt');
      return { c, link, score, why, state: isBackfilled(c.session) ? 'backfilled' : '' };
    });
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, n);
    process.stdout.write(`Top ${top.length} of ${cands.length} candidate(s) since ${since} for calibration (by cost, edits and link; sessions without commits are judged from the transcript reconstruction, tests not run)\n\n`);
    process.stdout.write(`${'session'.padEnd(10)} ${'date'.padEnd(11)} ${'repo'.padEnd(26)} ${'cost'.padStart(8)}  ${'why'.padEnd(52)} state\n`);
    for (const s of top) process.stdout.write(`${s.c.session.slice(0, 8).padEnd(10)} ${(s.c.started ?? '').slice(0, 10).padEnd(11)} ${shortRepo(s.c.repo).slice(0, 26).padEnd(26)} ${fmtUsd(s.c.cost).padStart(8)}  ${s.why.join(', ').slice(0, 52).padEnd(52)} ${s.state}\n${''.padEnd(10)} ${''.padEnd(11)} ${s.c.first_prompt.replace(/\s+/g, ' ').slice(0, 90)}\n`);
    const proj = projectCost(top.filter((s) => !s.state).map((s) => s.c), cfg);
    process.stdout.write(`\nProjected Tally spend to backfill the ${top.filter((s) => !s.state).length} not yet done: ${fmtUsd(proj.total_usd)}.\nNext: tally backfill add <session> [--max-spend 3]\n`);
    return;
  }

  if (sub === 'list') {
    const cands = scanSessions({ since, repo });
    if (!cands.length) {
      process.stdout.write(`No sessions with prompts found in the last ${since}${repo ? ` for ${repo}` : ''}.\n`);
      return;
    }
    process.stdout.write(`${cands.length} session(s) since ${since}${repo ? ` in ${repo}` : ''} (task link: URL in prompt > issue key in branch/commits > PR on branch)\n\n`);
    process.stdout.write(`${'session'.padEnd(10)} ${'date'.padEnd(11)} ${'repo'.padEnd(28)} ${'cost'.padStart(8)}  ${'link'.padEnd(40)} conf   state\n`);
    let linked = 0;
    for (const c of cands) {
      const link = detectTaskLink({ cwd: c.cwd, branch: c.branch, prompts: c.prompts, start: c.started, end: c.ended });
      if (link.kind !== 'none') linked += 1;
      const state = isBackfilled(c.session) ? 'backfilled' : '';
      const linkText = link.kind === 'none' ? '(none)' : `${link.url ?? link.ref}`;
      process.stdout.write(`${c.session.slice(0, 8).padEnd(10)} ${(c.started ?? '').slice(0, 10).padEnd(11)} ${shortRepo(c.repo).slice(0, 28).padEnd(28)} ${fmtUsd(c.cost).padStart(8)}  ${linkText.slice(0, 40).padEnd(40)} ${link.confidence.toFixed(1).padStart(4)}   ${state}\n`);
      if (!plain) process.stdout.write(`${''.padEnd(10)} ${''.padEnd(11)} ${c.first_prompt.replace(/\s+/g, ' ').slice(0, 70)}  · ${link.evidence}\n`);
    }
    const proj = projectCost(cands, cfg);
    process.stdout.write(`\n${linked}/${cands.length} with a detected task link. Projected cost to backfill all: ${fmtUsd(proj.total_usd)} (intake ${fmtUsd(proj.intake_usd)}, tier 1 ${fmtUsd(proj.tier1_usd)}, tier 2 ${fmtUsd(proj.tier2_usd)} on ${proj.tier2_sessions} session(s) ≥ $${cfg.judge.deepThreshold}).\n`);
    process.stdout.write(`Next: tally backfill add <session> [--task <url|text>]   or   tally backfill add all --max-spend 3\n`);
    return;
  }

  if (sub === 'add') {
    const target = args._[1];
    if (!target) {
      process.stderr.write('Usage: tally backfill add <session-prefix|all> [--task <url|text>] [--since 60d] [--repo path] [--max-spend 3] [--force]\n');
      return 1;
    }
    const cands = scanSessions({ since, repo });
    const chosen: SessionCandidate[] = target === 'all' ? cands.filter((c) => !isBackfilled(c.session) || has(args, 'force')) : cands.filter((c) => c.session.startsWith(target));
    if (!chosen.length) {
      process.stderr.write(target === 'all' ? 'Nothing to backfill (all candidates already done; pass --force to redo).\n' : `No session starting with "${target}" in the last ${since}. Run tally backfill list.\n`);
      return 1;
    }
    if (chosen.length > 1 && target !== 'all') {
      process.stderr.write(`"${target}" matches ${chosen.length} sessions; give more characters.\n`);
      return 1;
    }
    const maxSpend = Number(flag(args, 'max-spend') ?? 3);
    const already = backfillSpendSince(24);
    const proj = projectCost(chosen, cfg);
    process.stdout.write(`Backfilling ${chosen.length} session(s). Projected Tally spend ${fmtUsd(proj.total_usd)}; cap ${fmtUsd(maxSpend)} per 24 h across runs, ${fmtUsd(already)} already spent (intake hits the cache when the ticket text is unchanged).\n`);
    if (already >= maxSpend) {
      process.stdout.write(`Stopped before starting: backfill spend in the last 24 h (${fmtUsd(already)}) is at the --max-spend cap. Raise --max-spend or wait.\n`);
      return 1;
    }
    const cwds = [...new Set(chosen.map((c) => c.cwd).filter((x): x is string => !!x))];
    for (const c of cwds) {
      const consent = testRerunConsent(cfg, c);
      if (consent === undefined) process.stdout.write(`  ${c}: no test re-run consent stored; historical tests will not run (tally config consent on, run from that repo, to allow).\n`);
    }
    let spent = 0;
    let done = 0;
    for (const c of chosen) {
      if (already + spent >= maxSpend) {
        process.stdout.write(`Stopped: Tally backfill spend ${fmtUsd(already + spent)} in the last 24 h reached the --max-spend cap ${fmtUsd(maxSpend)} after ${done} session(s) this run.\n`);
        break;
      }
      if (isBackfilled(c.session) && !has(args, 'force')) {
        process.stdout.write(`${c.session.slice(0, 8)}: already backfilled (--force to redo)\n`);
        continue;
      }
      if (has(args, 'force')) for (const f of ['judge.json', 'task.json', 'coach_replay.json']) if (fs.existsSync(path.join(sessionDir(c.session), f))) fs.unlinkSync(path.join(sessionDir(c.session), f));
      process.stdout.write(`${c.session.slice(0, 8)} ${(c.started ?? '').slice(0, 10)} ${shortRepo(c.repo)} ${fmtUsd(c.cost)}\n`);
      try {
        const r = await backfillSession(c, { cfg, llm: makeLlm({ session: c.session }), taskRef: flag(args, 'task'), log: (s) => process.stdout.write(s + '\n') });
        if (r.skipped) process.stdout.write(`  skipped: ${r.skipped}\n`);
        spent += r.tally_spend_usd;
        done += 1;
      } catch (err) {
        process.stdout.write(`  failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    process.stdout.write(`\nDone: ${done} session(s), Tally spend ${fmtUsd(spent)}. Grade them blind: tally calibrate grade <session> [--grader you]\n`);
    return;
  }
  process.stderr.write('Usage: tally backfill list|add\n');
  return 1;
}
