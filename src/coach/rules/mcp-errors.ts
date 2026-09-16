import type { Rule, Suggestion } from '../types.js';
import { countBy, postTools, toolName } from '../helpers.js';

export const MCP_ERROR_THRESHOLD = 3;

export const mcpErrors: Rule = {
  id: 'mcp-errors',
  describe: 'An MCP tool keeps erroring',
  evaluate(ctx) {
    const out: Suggestion[] = [];
    const errs = countBy(
      postTools(ctx).filter((e) => e.data.is_error === true && toolName(e).startsWith('mcp__')),
      (e) => toolName(e),
    );
    for (const [tool, evs] of errs) {
      if (evs.length < MCP_ERROR_THRESHOLD) continue;
      const parts = tool.split('__');
      const server = parts[1] ?? tool;
      const head = String(evs[evs.length - 1]!.data.response_head ?? '').slice(0, 120);
      out.push({
        rule: this.id,
        key: `mcp-err:${tool}:${evs.length}`,
        severity: 'warn',
        title: `${server} MCP failed ${evs.length}×`,
        message: `${tool} has errored ${evs.length} times (${head || 'no detail'}). Retrying an MCP tool that returns the same error burns turns. Check auth or the server with /mcp, or tell Claude to stop using it.`,
        usd_saved: ctx.avgTurnCostUsd * evs.length,
        action: { kind: 'inject', label: 'Tell Claude to stop calling it', note: `The MCP tool ${tool} has failed ${evs.length} times with: ${head || 'the same error'}. Do not call it again this session; use another route or ask the user to fix the server.` },
      });
    }
    return out;
  },
};
