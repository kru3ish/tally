import type { Rule, Suggestion } from '../types.js';
import { countBy, normPath, postTools, shortPath, toolInput, toolName } from '../helpers.js';

export const REREAD_THRESHOLD = 3;

export const reread: Rule = {
  id: 'reread',
  describe: 'The same file is read 3 or more times',
  evaluate(ctx) {
    const out: Suggestion[] = [];
    const reads = countBy(
      postTools(ctx).filter((e) => toolName(e) === 'Read'),
      (e) => normPath(toolInput(e).file_path),
    );
    for (const [file, evs] of reads) {
      if (evs.length < REREAD_THRESHOLD) continue;
      const chars = evs.reduce((s, e) => s + Number(e.data.response_chars ?? 0), 0);
      const extra = evs.length - 1;
      const tokens = Math.round(chars / 4 / evs.length);
      out.push({
        rule: this.id,
        key: `reread:${file}:${evs.length}`,
        severity: 'warn',
        title: `${shortPath(file, ctx.cwd)} read ${evs.length}×`,
        message: `${shortPath(file, ctx.cwd)} has been read ${evs.length} times (~${tokens.toLocaleString()} tokens each). Every re-read is billed again and sits in context. Pin the parts that matter instead.`,
        usd_saved: ctx.avgTurnCostUsd * extra,
        action: {
          kind: 'inject',
          label: 'Ask Claude to keep notes instead of re-reading',
          note: `You have read ${shortPath(file, ctx.cwd)} ${evs.length} times. Keep the relevant symbols and line ranges in your working notes (or HANDOFF.md) rather than re-reading the whole file.`,
        },
      });
    }
    return out;
  },
};
