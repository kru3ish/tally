import type { Rule, Suggestion } from '../types.js';
import { countBy, norm, normPath, postTools, toolInput, toolName } from '../helpers.js';

export const LOOP_THRESHOLD = 3;

export const loopDetect: Rule = {
  id: 'loop-detect',
  describe: 'The same failing command or edit repeats 3+ times',
  evaluate(ctx) {
    const out: Suggestion[] = [];
    const failing = postTools(ctx).filter((e) => e.data.is_error === true);
    const cmds = countBy(
      failing.filter((e) => toolName(e) === 'Bash'),
      (e) => norm(toolInput(e).command),
    );
    for (const [cmd, evs] of cmds) {
      if (evs.length < LOOP_THRESHOLD) continue;
      const cost = ctx.avgTurnCostUsd * evs.length;
      out.push({
        rule: this.id,
        key: `loop:${cmd}:${evs.length}`,
        severity: 'critical',
        title: `Same command failed ${evs.length}×`,
        message: `\`${cmd.slice(0, 80)}\` has failed ${evs.length} times in a row. Each retry costs about $${ctx.avgTurnCostUsd.toFixed(2)}. Stop, read the full error, and change the approach.`,
        usd_saved: cost,
        action: {
          kind: 'inject',
          label: 'Tell Claude to stop and diagnose',
          note: `Tally observed \`${cmd.slice(0, 120)}\` fail ${evs.length} times with the same result this session; each retry cost about $${ctx.avgTurnCostUsd.toFixed(2)} and produced no new information.`,
        },
      });
    }
    const edits = countBy(
      failing.filter((e) => toolName(e) === 'Edit' || toolName(e) === 'MultiEdit'),
      (e) => `${normPath(toolInput(e).file_path)}::${String(toolInput(e).old_string ?? '').slice(0, 60)}`,
    );
    for (const [key, evs] of edits) {
      if (evs.length < LOOP_THRESHOLD) continue;
      const file = key.split('::')[0]!;
      out.push({
        rule: this.id,
        key: `loop-edit:${key}:${evs.length}`,
        severity: 'critical',
        title: `Same edit failed ${evs.length}×`,
        message: `The same edit to ${file} has failed ${evs.length} times (old_string not found?). Re-read the file before editing again.`,
        usd_saved: ctx.avgTurnCostUsd * evs.length,
        action: { kind: 'inject', label: 'Tell Claude to re-read before editing', note: `Tally observed ${evs.length} failed edits to ${file} with the same old_string; the file's current contents differ from what the edits expect.` },
      });
    }
    return out;
  },
};
