import { type Args, flag, has } from '../cli.js';
import { loadConfig } from '../config.js';
import { resolveSession, sessionCwd, transcriptPathFor } from '../session.js';
import { buildContext } from '../coach/context.js';
import { CoachEngine, loadState, saveState } from '../coach/engine.js';
import { renderHeader, renderSuggestion } from '../coach/ui.js';
import { applySuggestion, injectSuggestion } from '../coach/actions.js';
import { llmCoach } from '../coach/llm-coach.js';
import { makeLlm } from '../llm/client.js';
import { readFlags, flagsFile } from './statusline.js';
import { writeJson, builtCliPath } from '../paths.js';
import { enqueueInject } from '../coach/inject.js';
import { loadPolicy } from '../policy.js';
import { hardStopFile, isApproved } from './budget.js';
import fs from 'node:fs';

export async function run(args: Args): Promise<number | void> {
  const cfg = loadConfig();
  const session = resolveSession(flag(args, 'session'), process.cwd());
  if (!session) {
    process.stderr.write('No session found.\n');
    return 1;
  }
  const cwd = flag(args, 'cwd') || sessionCwd(session) || process.cwd();
  const color = !has(args, 'plain');
  const ctx = buildContext({ session, cwd, cfg, transcriptPath: transcriptPathFor(session) });
  const engine = new CoachEngine(loadState(session), cfg);
  if (has(args, 'tick')) {
    /* autopilot: one Coach pass, spawned by the Stop hook. Suggestions with an observation are queued for Claude's
       next turn; the rest (a .md to write, a consent or confirmation to give) become flags on the status line. */
    const result = engine.tick(ctx);
    let shown = result.show;
    if (!shown.length && ctx.spendUsd >= cfg.coach.llm_min_session_usd && engine.llmAllowed(ctx.now, ctx.events.length) && ctx.events.some((e) => e.type === 'post_tool')) {
      engine.markLlm(ctx.now, ctx.events.length);
      try {
        const s = await llmCoach(ctx, makeLlm({ session }));
        if (s) shown = engine.tick(ctx, [s]).show;
      } catch {
        /* the deterministic rules already ran */
      }
    }
    /* repo policy hard stop: spend past the budget writes a marker the PreToolUse hook enforces; approval clears it */
    const pol = loadPolicy(cwd);
    if (ctx.task && pol.policy.budget.hard_stop && ctx.task.budget_usd > 0) {
      const over = ctx.spendUsd >= ctx.task.budget_usd;
      if (over && !isApproved(session) && !fs.existsSync(hardStopFile(session))) writeJson(hardStopFile(session), { ts: new Date().toISOString(), spend_usd: ctx.spendUsd, budget_usd: ctx.task.budget_usd, policy_file: pol.file });
      else if (!over && fs.existsSync(hardStopFile(session))) fs.unlinkSync(hardStopFile(session));
    }
    const flags = readFlags(session);
    /* a flag whose rule no longer fires (the file got written, the task was confirmed) is dropped */
    const live = new Set(engine.evaluate(ctx).map((s) => s.key));
    flags.pending = flags.pending.filter((f) => live.has(f.key));
    /* a confirmation or consent waits for a human, so it is a status-line flag even while the noise limit holds it back */
    for (const s of result.held) if ((s.action.kind === 'confirm' || s.action.kind === 'consent') && !flags.pending.some((f) => f.key === s.key)) flags.pending.push({ rule: s.rule, key: s.key, title: s.title, usd_saved: s.usd_saved, label: s.action.label });
    let injected = 0;
    for (const s of shown) {
      /* only a pure observation is injected on its own; an inject_note that accompanies a write (HANDOFF.md, CLAUDE.md)
         describes a file autopilot has not written, so those wait for a human as flags */
      if (s.action.kind === 'inject') {
        injectSuggestion(s, { session, cwd });
        injected += 1;
      } else if (!flags.pending.some((f) => f.key === s.key)) flags.pending.push({ rule: s.rule, key: s.key, title: s.title, usd_saved: s.usd_saved, ts: s.ts, label: s.action.label });
    }
    /* hand new flags to Claude once, with the exact command, so the user can decide in the conversation and Claude runs it */
    const announced = new Set(flags.announced ?? []);
    const fresh = flags.pending.filter((f) => !announced.has(f.key));
    if (fresh.length) {
      const cli = builtCliPath().replace(/\\/g, '/');
      const lines = fresh.map((f, i) => `(${i + 1}) ${f.title}${f.label ? ` [${f.label}]` : ''} → node "${cli}" coach --apply ${f.rule} --session ${session}`);
      enqueueInject(session, `Tally observed ${fresh.length} Coach flag${fresh.length === 1 ? '' : 's'} waiting for a decision from the user: ${lines.join('; ')}. Each is the user's call; Tally records the answer when the command runs.`, 'autopilot:flags', cwd);
      for (const f of fresh) announced.add(f.key);
    }
    writeJson(flagsFile(session), { pending: flags.pending, announced: [...announced].filter((k) => flags.pending.some((f) => f.key === k)), updated: new Date().toISOString() });
    saveState(session, engine.state);
    if (!has(args, 'auto')) process.stdout.write(`autopilot: ${shown.length} suggestion(s), ${injected} queued for Claude's next turn, ${flags.pending.length} flag(s) on the status line\n`);
    return;
  }
  const all = engine.evaluate(ctx);
  const applyIdx = flag(args, 'apply');
  const injectIdx = flag(args, 'inject');
  if (applyIdx !== undefined || injectIdx !== undefined) {
    /* a number is the index in the list; anything else is a rule id or key, which is what the injected flag note uses */
    const target = String(applyIdx ?? injectIdx);
    const s = /^\d+$/.test(target) ? all[Number(target) - 1] : all.find((x) => x.rule === target || x.key === target);
    if (!s) {
      process.stderr.write(`No suggestion ${/^\d+$/.test(target) ? '#' + target : `for ${target}`}. Run \`tally coach --once\` to list them.\n`);
      return 1;
    }
    const r = applyIdx !== undefined ? applySuggestion(s, { session, cwd, cfg, mode: 'ask' }) : injectSuggestion(s, { session, cwd });
    if (r.ok) {
      const flags = readFlags(session);
      writeJson(flagsFile(session), { pending: flags.pending.filter((f) => f.key !== s.key), updated: new Date().toISOString() });
    }
    process.stdout.write(`${r.ok ? 'ok' : 'failed'}: ${r.detail}\n`);
    return r.ok ? 0 : 1;
  }
  process.stdout.write(renderHeader(ctx, color) + '\n\n');
  if (!all.length && !readFlags(session).pending.length) {
    process.stdout.write('No suggestions right now.\n');
    return;
  }
  const result = engine.tick(ctx, all);
  const list = has(args, 'all') ? all : [...result.show, ...result.held];
  list.forEach((s, i) => process.stdout.write(renderSuggestion(s, color, i + 1) + '\n\n'));
  if (!has(args, 'all')) saveState(session, engine.state);
  /* flags: what autopilot left for a human, with the index that --apply / --inject take */
  const flagged = readFlags(session).pending.map((f) => ({ ...f, idx: all.findIndex((s) => s.key === f.key) + 1 }));
  if (flagged.length) {
    process.stdout.write(`Waiting for you (${flagged.length} flag${flagged.length === 1 ? '' : 's'} from autopilot):\n`);
    for (const f of flagged) process.stdout.write(`  ${f.idx > 0 ? `#${f.idx}` : ' ·'}  ${f.title}${f.label ? `  →  ${f.label}` : ''}${f.idx > 0 ? `   (tally coach --apply ${f.idx})` : '   (no longer applicable; cleared on the next tick)'}\n`);
    process.stdout.write('\n');
  }
  process.stdout.write(`Act on one: tally coach --apply <#> | --inject <#>   (or run \`tally watch\` for the live pane)\n`);
}
