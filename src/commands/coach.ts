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
import { writeJson } from '../paths.js';

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
    const flags = readFlags(session);
    /* a confirmation or consent waits for a human, so it is a status-line flag even while the noise limit holds it back */
    for (const s of result.held) if ((s.action.kind === 'confirm' || s.action.kind === 'consent') && !flags.pending.some((f) => f.key === s.key)) flags.pending.push({ rule: s.rule, key: s.key, title: s.title, usd_saved: s.usd_saved, label: s.action.label });
    let injected = 0;
    for (const s of shown) {
      const note = s.action.kind === 'inject' ? s.action.note : s.inject_note;
      if (note) {
        injectSuggestion(s, { session, cwd });
        injected += 1;
      } else if (!flags.pending.some((f) => f.key === s.key)) flags.pending.push({ rule: s.rule, key: s.key, title: s.title, usd_saved: s.usd_saved, ts: s.ts, label: s.action.label });
    }
    writeJson(flagsFile(session), { pending: flags.pending, updated: new Date().toISOString() });
    saveState(session, engine.state);
    if (!has(args, 'auto')) process.stdout.write(`autopilot: ${shown.length} suggestion(s), ${injected} queued for Claude's next turn, ${flags.pending.length} flag(s) on the status line\n`);
    return;
  }
  const all = engine.evaluate(ctx);
  const applyIdx = flag(args, 'apply');
  const injectIdx = flag(args, 'inject');
  if (applyIdx !== undefined || injectIdx !== undefined) {
    const idx = Number(applyIdx ?? injectIdx) - 1;
    const s = all[idx];
    if (!s) {
      process.stderr.write(`No suggestion #${idx + 1}. Run \`tally coach --once\` to list them.\n`);
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
  if (!all.length) {
    process.stdout.write('No suggestions right now.\n');
    return;
  }
  const result = engine.tick(ctx, all);
  const list = has(args, 'all') ? all : [...result.show, ...result.held];
  list.forEach((s, i) => process.stdout.write(renderSuggestion(s, color, i + 1) + '\n\n'));
  if (!has(args, 'all')) saveState(session, engine.state);
  process.stdout.write(`Act on one: tally coach --apply <#> | --inject <#>   (or run \`tally watch\` for the live pane)\n`);
}
