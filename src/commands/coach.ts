import { type Args, flag, has } from '../cli.js';
import { loadConfig } from '../config.js';
import { resolveSession, sessionCwd, transcriptPathFor } from '../session.js';
import { buildContext } from '../coach/context.js';
import { CoachEngine, loadState, saveState } from '../coach/engine.js';
import { renderHeader, renderSuggestion } from '../coach/ui.js';
import { applySuggestion, injectSuggestion } from '../coach/actions.js';

export async function run(args: Args): Promise<number | void> {
  const cfg = loadConfig();
  const session = resolveSession(flag(args, 'session'), process.cwd());
  if (!session) {
    process.stderr.write('No session found.\n');
    return 1;
  }
  const cwd = sessionCwd(session) ?? process.cwd();
  const color = !has(args, 'plain');
  const ctx = buildContext({ session, cwd, cfg, transcriptPath: transcriptPathFor(session) });
  const engine = new CoachEngine(loadState(session), cfg);
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
