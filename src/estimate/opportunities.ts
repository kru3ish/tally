/* What to ADD for the next similar story: a cheaper subagent, a project skill, an MCP server or a setting, each one
   suggested only when the session's own transcript shows the pattern it addresses, with the dollars that pattern cost
   and an estimate of the share the addition would save. The waste drivers (variance.ts) say what to stop doing;
   these say what to start using.

   Third-party MCP servers are suggested with the install command their own documentation gives (checked 2026-10-18):
   Context7 https://context7.com/docs/resources/all-clients, Serena https://oraios.github.io/serena/02-usage/030_clients.html.
   Tally never installs them itself. */
import path from 'node:path';
import { priceFor, type Pricing } from '../cost/pricing.js';
import { isLintCommand, isTestCommand, type ToolCall, type Transcript } from '../transcript/parse.js';
import type { Driver, Fix } from './variance.js';

const round2 = (n: number) => Math.round(n * 100) / 100;
const $ = (n: number) => `$${n.toFixed(2)}`;

/* what it costs to carry `chars` of tool output: written to the cache once, then re-read on every later call of the
   same agent (the main loop, or the subagent that ran the tool) */
function carryCost(t: Transcript, call: ToolCall, chars: number, pricing: Pricing): number {
  if (chars <= 0) return 0;
  const msg = t.messages.find((m) => m.id === call.messageId);
  const p = priceFor(msg?.model, pricing);
  const tokens = chars / 4;
  const later = t.messages.filter((m) => m.agent === call.agent && m.ts > call.ts).length;
  return (tokens * p.cache_write_5m + tokens * p.cache_read * later) / 1e6;
}

const DOCS_RE = /(^|\/\/|\.)(docs?|developer|developers|devdocs|readthedocs|api)\.|\/docs?\/|\/api\/|\/reference\/|npmjs\.com|pypi\.org|pkg\.go\.dev|crates\.io|docs\.rs|mdn|stackoverflow\.com/i;
const DEP_RE = /\/(node_modules|site-packages|\.venv|vendor|\.cargo\/registry|go\/pkg\/mod)\//;
/* source code, where reading one symbol instead of the file is possible; not docs, data, logs or Claude Code's own
   saved tool results */
const CODE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|scala|rb|php|cs|cpp|cc|c|h|hpp|swift|m|vue|svelte|dart|lua|ex|exs|clj|hs|ml|sql)$/i;

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 40)
      .replace(/^-+|-+$/g, '') || 'story'
  );
}

export function quietFlag(cmd: string): string | undefined {
  if (/\bvitest\b/.test(cmd)) return `${cmd} --reporter=dot`;
  if (/\bjest\b/.test(cmd)) return `${cmd} --silent`;
  if (/\bpytest\b|py\.test/.test(cmd)) return `${cmd} -q --no-header -rN`;
  if (/\bgo test\b/.test(cmd)) return cmd.replace(/\s-v\b/, '');
  if (/\bcargo test\b/.test(cmd)) return `${cmd} -q`;
  if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b/.test(cmd)) return `${cmd} --silent`;
  if (/\bnode --test\b/.test(cmd)) return `${cmd} --test-reporter=dot`;
  return undefined;
}

export function findOpportunities(t: Transcript, opts: { cwd?: string; loaded?: { mcp?: string[]; skills?: string[]; plugins?: string[] }; story?: string; pricing: Pricing }): Driver[] {
  const out: Driver[] = [];
  const pricing = opts.pricing;
  const main = t.messages.filter((m) => m.agent === 'main' && !m.model.startsWith('<'));
  const mainCost = main.reduce((s, m) => s + m.cost, 0);
  const mainModel = main[0]?.model;
  const mainPrice = priceFor(mainModel, pricing);
  const haiku = priceFor('haiku', pricing);
  const loadedMcp = new Set((opts.loaded?.mcp ?? []).map((m) => m.toLowerCase()));
  const usedMcp = new Set(t.mcpCalls.map((c) => c.server.toLowerCase()));
  const has = (name: string) => loadedMcp.has(name) || usedMcp.has(name);
  const mainCalls = t.toolCalls.filter((c) => c.agent === 'main');
  const allCalls = t.toolCalls;
  const where = (cs: ToolCall[]) => {
    const sub = cs.filter((c) => c.agent !== 'main').length;
    return !sub ? '' : sub === cs.length ? ' (all in subagents)' : ` (${sub} of them in subagents)`;
  };
  const rel = (f: string) => (opts.cwd && path.isAbsolute(f) && !path.relative(opts.cwd, f).startsWith('..') ? path.relative(opts.cwd, f).replace(/\\/g, '/') : f);

  /* 1. exploration on the main model: a haiku "scout" subagent finds things and hands back paths and summaries */
  const exploreCost = main.filter((m) => m.phase === 'explore').reduce((s, m) => s + m.cost, 0);
  const exploreCalls = mainCalls.filter((c) => c.phase === 'explore' && ['Read', 'Grep', 'Glob', 'LS'].includes(c.name));
  const scoutSave = exploreCost * (1 - haiku.output / Math.max(mainPrice.output, haiku.output)) * 0.5;
  if (exploreCalls.length >= 6 && exploreCost >= 0.05 && exploreCost >= mainCost * 0.25 && scoutSave >= 0.01) {
    out.push({
      id: 'scout',
      group: 'add',
      title: 'Add a Haiku scout subagent for exploring the code',
      usd: round2(scoutSave),
      detail: `${exploreCalls.length} Read/Grep/Glob calls before the first edit cost ${$(exploreCost)} on ${mainModel}. A scout subagent on Haiku does the searching and returns paths and summaries; estimate assumes it takes half of that work.`,
      basis: 'estimated',
      fix: {
        id: 'scout',
        title: 'Create .claude/agents/scout.md (Haiku, read-only)',
        what: 'writes a project subagent with model: haiku and tools Read, Grep, Glob; commit it and the team has it',
        apply: {
          kind: 'file',
          path: '.claude/agents/scout.md',
          content: `---\nname: scout\ndescription: Use proactively before editing, to find where something lives in this codebase. Searches and reads files, then returns file paths, line numbers and a short summary of what is there, never whole files.\ntools: Read, Grep, Glob\nmodel: haiku\n---\n\nYou are a fast, read-only codebase scout. Answer the question you are given with:\n- the files and line ranges that matter, most relevant first\n- two or three sentences on how they fit together\n- anything surprising (dead code, a second implementation, a test that covers it)\n\nDo not paste whole files. Quote at most a few lines when the exact text matters.\n`,
        },
      },
    });
  }

  /* 2. documentation looked up on the web or read out of installed dependencies → Context7 serves current docs */
  const docCalls = mainCalls.filter((c) => {
    const target = String(c.input.url ?? c.input.query ?? c.input.file_path ?? '');
    return ((c.name === 'WebFetch' || c.name === 'WebSearch') && DOCS_RE.test(target)) || (c.name === 'Read' && DEP_RE.test(target.replace(/\\/g, '/')));
  });
  if (docCalls.length >= 2 && !has('context7')) {
    const usd = docCalls.reduce((s, c) => s + carryCost(t, c, c.result?.chars ?? 0, pricing), 0) * 0.5;
    if (usd >= 0.01)
      out.push({
        id: 'docs',
        group: 'add',
        title: 'Add the Context7 MCP server for library docs',
        usd: round2(usd),
        detail: `${docCalls.length} documentation lookups (web pages or files inside installed dependencies) were pulled into the context whole. Context7 returns the relevant section of current docs for a library; estimate assumes half the tokens.`,
        basis: 'estimated',
        fix: { id: 'context7', title: 'Install Context7', what: 'adds the hosted Context7 server (an API key from context7.com only raises rate limits)', apply: { kind: 'command', commands: ['claude mcp add --transport http context7 https://mcp.context7.com/mcp'] } },
      });
  }

  /* 3. whole large files read into context → Serena reads by symbol */
  const bigReads = allCalls.filter((c) => {
    const f = String(c.input.file_path ?? '').replace(/\\/g, '/');
    return c.name === 'Read' && (c.result?.chars ?? 0) > 12000 && CODE_RE.test(f) && !DEP_RE.test(f) && !f.includes('/.claude/');
  });
  const bigChars = bigReads.reduce((s, c) => s + (c.result?.chars ?? 0), 0);
  if (bigReads.length >= 3 && !has('serena')) {
    const usd = bigReads.reduce((s, c) => s + carryCost(t, c, c.result?.chars ?? 0, pricing), 0) * 0.6;
    if (usd >= 0.02)
      out.push({
        id: 'big-reads',
        group: 'add',
        title: 'Read code by symbol instead of whole files',
        usd: round2(usd),
        detail: `${bigReads.length} large source files (${Math.round(bigChars / 4000)}k tokens) were read whole${where(bigReads)} and stayed in context. For example ${[...new Set(bigReads.map((c) => rel(String(c.input.file_path))))].slice(0, 3).join(', ')}. A language server or Serena fetches one function or class instead of the file; estimate assumes 60% fewer tokens.`,
        basis: 'estimated',
        fix: { id: 'serena', title: 'Install Serena', what: 'needs uv; Serena runs locally and indexes this project', apply: { kind: 'command', commands: ['uv tool install -p 3.13 serena-agent', 'claude mcp add serena -- serena start-mcp-server --context claude-code --project "$(pwd)"'] } },
      });
  }

  /* 4. noisy test or lint output carried for the rest of the session → a project skill with the quiet invocation */
  const noisy = allCalls.filter((c) => c.name === 'Bash' && typeof c.input.command === 'string' && (isTestCommand(c.input.command) || isLintCommand(c.input.command)) && (c.result?.chars ?? 0) > 6000);
  if (noisy.length >= 2) {
    const usd = noisy.reduce((s, c) => s + carryCost(t, c, (c.result?.chars ?? 0) - 1500, pricing), 0) * 0.7;
    const cmd = String(noisy[0]!.input.command).trim();
    const quiet = quietFlag(cmd);
    if (usd >= 0.01 && quiet)
      out.push({
        id: 'noisy-tests',
        group: 'add',
        title: 'Add a run-tests skill with a quiet reporter',
        usd: round2(usd),
        detail: `${noisy.length} test/lint runs${where(noisy)} printed ${Math.round(noisy.reduce((s, c) => s + (c.result?.chars ?? 0), 0) / 4000)}k tokens of output that stayed in context. \`${quiet}\` prints the failures and a summary; estimate assumes 70% less.`,
        basis: 'estimated',
        fix: {
          id: 'run-tests-skill',
          title: 'Create .claude/skills/run-tests/SKILL.md',
          what: `a project skill telling the agent to run \`${quiet}\` and read only the failures`,
          apply: {
            kind: 'file',
            path: '.claude/skills/run-tests/SKILL.md',
            content: `---\nname: run-tests\ndescription: How to run this repository's tests cheaply. Use whenever you need to run or re-run the tests.\n---\n\nRun the tests with a quiet reporter so only failures and the summary come back:\n\n\`\`\`bash\n${quiet}\n\`\`\`\n\n- Read the failure section, not the whole log. If you need one test, run it alone by name.\n- Do not re-run an unchanged command after a failure; change something first.\n`,
          },
        },
      });
  }

  /* 4b. any command output above 15k characters, carried for the rest of that agent's conversation */
  const bigBash = allCalls.filter((c) => c.name === 'Bash' && (c.result?.chars ?? 0) > 15000);
  if (bigBash.length >= 3) {
    const usd = bigBash.reduce((s, c) => s + carryCost(t, c, (c.result?.chars ?? 0) - 15000, pricing), 0);
    if (usd >= 0.02)
      out.push({
        id: 'bash-output',
        group: 'add',
        title: 'Cap command output at 15k characters',
        usd: round2(usd),
        detail: `${bigBash.length} commands${where(bigBash)} returned more than 15k characters (up to ${Math.round(Math.max(...bigBash.map((c) => c.result?.chars ?? 0)) / 1000)}k), and the excess was re-sent on every later call. BASH_MAX_OUTPUT_LENGTH=15000 keeps the head and tail; the figure is what the excess cost.`,
        basis: 'estimated',
        fix: { id: 'bash-output-cap', title: 'Set BASH_MAX_OUTPUT_LENGTH=15000', what: 'sets env BASH_MAX_OUTPUT_LENGTH in .claude/settings.json (Claude Code default is 30000)', apply: { kind: 'settings', patch: { env: { BASH_MAX_OUTPUT_LENGTH: '15000' } }, scope: 'project' } },
      });
  }

  /* 4c. a context that grew far past what the work needed: every call re-sent all of it */
  const WINDOW = 200000;
  let windowUsd = 0;
  let windowCalls = 0;
  let maxCtx = 0;
  for (const m of t.messages) {
    if (m.model.startsWith('<')) continue;
    const ctx = m.usage.input + m.usage.cache_read + m.usage.cache_write;
    maxCtx = Math.max(maxCtx, ctx);
    if (ctx > WINDOW) {
      windowUsd += ((ctx - WINDOW) * priceFor(m.model, pricing).cache_read) / 1e6;
      windowCalls += 1;
    }
  }
  if (windowCalls >= 10 && windowUsd >= 0.1) {
    out.push({
      id: 'compact-window',
      group: 'add',
      title: 'Compact before the context passes 200k tokens',
      usd: round2(windowUsd * 0.8),
      detail: `The context reached ${Math.round(maxCtx / 1000)}k tokens${t.compactions.length ? '' : ' and never compacted'}, so ${windowCalls} calls re-sent more than 200k each. autoCompactWindow: 200000 compacts there instead of near the model's limit; estimate keeps 20% for the compactions themselves. A compacted summary loses detail, so keep the plan in a file.`,
      basis: 'estimated',
      fix: { id: 'compact-window', title: 'Set autoCompactWindow to 200000', what: 'sets "autoCompactWindow": 200000 in .claude/settings.json (Claude Code 2.1.288+); raise it for a story that needs the whole context', apply: { kind: 'settings', patch: { autoCompactWindow: 200000 }, scope: 'project' } },
    });
  }

  /* 5. huge MCP tool results */
  const bigMcp = allCalls.filter((c) => c.name.startsWith('mcp__') && (c.result?.chars ?? 0) > 40000);
  if (bigMcp.length >= 1) {
    const usd = bigMcp.reduce((s, c) => s + carryCost(t, c, (c.result?.chars ?? 0) - 40000, pricing), 0);
    if (usd >= 0.01)
      out.push({
        id: 'mcp-output',
        group: 'add',
        title: 'Cap MCP tool output',
        usd: round2(usd),
        detail: `${bigMcp.length} MCP result(s) above 10k tokens (${[...new Set(bigMcp.map((c) => c.name.split('__')[1]))].join(', ')}). MAX_MCP_OUTPUT_TOKENS=10000 truncates them; the figure is what the excess cost.`,
        basis: 'estimated',
        fix: { id: 'mcp-output-cap', title: 'Set MAX_MCP_OUTPUT_TOKENS=10000', what: 'sets env MAX_MCP_OUTPUT_TOKENS in .claude/settings.json', apply: { kind: 'settings', patch: { env: { MAX_MCP_OUTPUT_TOKENS: '10000' } }, scope: 'project' } },
      });
  }

  /* 6. output-heavy (thinking is billed as output) on the main loop */
  const outUsd = main.reduce((s, m) => s + (m.usage.output * priceFor(m.model, pricing).output) / 1e6, 0);
  const outTokens = main.reduce((s, m) => s + m.usage.output, 0);
  if (outTokens > 30000 && outUsd > mainCost * 0.45 && outUsd >= 0.1) {
    out.push({
      id: 'effort',
      group: 'add',
      title: 'Lower the default effort',
      usd: round2(outUsd * 0.3),
      detail: `output and thinking were ${$(outUsd)} of the main loop's ${$(mainCost)} (${Math.round(outTokens / 1000)}k tokens). Medium effort thinks less on routine steps; estimate assumes 30% fewer output tokens. Raise it with /effort for a hard story.`,
      basis: 'estimated',
      fix: { id: 'effort-medium', title: 'Default effort to medium', what: 'sets "effortLevel": "medium" in .claude/settings.json', apply: { kind: 'settings', patch: { effortLevel: 'medium' }, scope: 'project' } },
    });
  }

  /* 7. the story itself as a skill: what this session had to discover (files, commands) so the next similar story starts there */
  const edited = [...new Set(mainCalls.filter((c) => ['Edit', 'Write', 'MultiEdit'].includes(c.name) && typeof c.input.file_path === 'string').map((c) => rel(String(c.input.file_path))))].slice(0, 12);
  const worked = [...new Set(mainCalls.filter((c) => c.name === 'Bash' && !c.result?.isError && typeof c.input.command === 'string' && (isTestCommand(c.input.command) || isLintCommand(c.input.command) || /\b(build|make)\b/.test(c.input.command)) && c.input.command.length < 120 && !c.input.command.includes('\n')).map((c) => String(c.input.command).trim()))].slice(0, 5);
  if (edited.length >= 2 && exploreCost >= 0.05 && opts.story) {
    const name = slug(opts.story);
    out.push({
      id: 'story-skill',
      group: 'add',
      title: 'Save what this story taught as a project skill',
      usd: round2(exploreCost * 0.5),
      detail: `this session spent ${$(exploreCost)} finding its way before the first edit. A skill with the files it touched and the commands that worked lets the next similar story start there; estimate assumes it halves that.`,
      basis: 'estimated',
      fix: {
        id: 'story-skill',
        title: `Create .claude/skills/${name}/SKILL.md`,
        what: 'a project skill from this session: when to use it, the files involved, the commands that worked',
        apply: {
          kind: 'file',
          path: `.claude/skills/${name}/SKILL.md`,
          content: `---\nname: ${name}\ndescription: Context for work like "${opts.story.replace(/"/g, "'").slice(0, 120)}" in this repository. Use when a task touches the same area.\n---\n\nRecorded by Tally from a finished session.\n\n## Files involved\n${edited.map((f) => `- ${f}`).join('\n')}\n${worked.length ? `\n## Commands that worked\n${worked.map((c) => `- \`${c}\``).join('\n')}\n` : ''}`,
        },
      },
    });
  }
  return out;
}

export type { Fix };
