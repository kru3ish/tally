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
          note: `The command \`${cmd.slice(0, 120)}\` has failed ${evs.length} times with the same result. Do not run it again unchanged. Read the full error output, state the root cause in one sentence, and either fix that cause or ask the user.`,
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
        action: { kind: 'inject', label: 'Tell Claude to re-read before editing', note: `Your edit to ${file} has failed ${evs.length} times. Read the current file contents first, then make one edit that matches them exactly.` },
      });
    }
    return out;
  },
};
