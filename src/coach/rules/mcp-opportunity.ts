import type { Rule, Suggestion } from '../types.js';
import { postTools, toolInput, toolName } from '../helpers.js';

interface Opportunity {
  server: string;
  test: (cmd: string, tool: string) => boolean;
  why: string;
  snippet: string;
}

export const OPPORTUNITIES: Opportunity[] = [
  {
    server: 'github',
    test: (cmd, tool) => tool === 'Bash' && /\bgh\s+(issue|pr|api|repo|run)\b/.test(cmd),
    why: 'structured issue/PR data without parsing gh output',
    snippet: 'claude mcp add github -- npx -y @modelcontextprotocol/server-github',
  },
  {
    server: 'atlassian',
    test: (cmd, tool) => tool === 'Bash' && /atlassian\.net|\/rest\/api\/(2|3)\//.test(cmd),
    why: 'Jira reads and comments as tools instead of curl',
    snippet: 'claude mcp add atlassian -- npx -y mcp-remote https://mcp.atlassian.com/v1/sse',
  },
  {
    server: 'linear',
    test: (cmd, tool) => tool === 'Bash' && /api\.linear\.app/.test(cmd),
    why: 'Linear issues as tools',
    snippet: 'claude mcp add linear -- npx -y mcp-remote https://mcp.linear.app/sse',
  },
  {
    server: 'postgres',
    test: (cmd, tool) => tool === 'Bash' && /\bpsql\b|\bpg_dump\b/.test(cmd),
    why: 'schema and query access with result shaping',
    snippet: 'claude mcp add postgres -- npx -y @modelcontextprotocol/server-postgres "$DATABASE_URL"',
  },
  {
    server: 'playwright',
    test: (cmd, tool) => (tool === 'Bash' && /\b(playwright|puppeteer|chromium|headless)\b/.test(cmd)) || tool === 'WebFetch' && /localhost|127\.0\.0\.1/.test(cmd),
    why: 'drive a real browser instead of shelling out',
    snippet: 'claude mcp add playwright -- npx -y @playwright/mcp@latest',
  },
  {
    server: 'context7',
    test: (cmd, tool) => tool === 'WebFetch' && /docs\.|\/docs\/|readthedocs|developer\.mozilla|npmjs\.com/.test(cmd),
    why: 'versioned library docs on demand without repeated fetches',
    snippet: 'claude mcp add context7 -- npx -y @upstash/context7-mcp',
  },
];

export const MCP_OPPORTUNITY_THRESHOLD = 3;

export const mcpOpportunity: Rule = {
  id: 'mcp-opportunity',
  describe: 'Repeated shell or web fetches that an MCP server would handle better',
  evaluate(ctx) {
    const out: Suggestion[] = [];
    const calls = postTools(ctx).map((e) => ({ tool: toolName(e), cmd: String(toolInput(e).command ?? toolInput(e).url ?? '') }));
    for (const op of OPPORTUNITIES) {
      if (ctx.loaded.mcp.some((m) => m.toLowerCase().includes(op.server))) continue;
      const n = calls.filter((c) => op.test(c.cmd, c.tool)).length;
      if (n < MCP_OPPORTUNITY_THRESHOLD) continue;
      out.push({
        rule: this.id,
        key: `mcp-op:${op.server}`,
        severity: 'info',
        title: `${n} shell/web calls the ${op.server} MCP would handle`,
        message: `${n} calls this session went through the shell or web fetch for ${op.server}: ${op.why}. An MCP server returns structured results and fewer retries.`,
        usd_saved: ctx.avgTurnCostUsd * Math.max(1, n / 3),
        action: { kind: 'snippet', label: 'Show the config command', snippet: op.snippet, where: 'run once in this repo (or add --scope user)' },
      });
    }
    return out;
  },
};
