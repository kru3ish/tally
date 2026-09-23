/* Tally as an MCP server (stdio, JSON-RPC 2.0) so the agent can ask what is still unmet before it claims it is done.
   No SDK: the protocol surface Tally needs is initialize, tools/list, tools/call and ping. Started by the plugin
   (`mcpServers` in plugin.json) or registered for CLI installs with `tally mcp --install`. The session is the newest
   active one for the working directory, the same rule the slash commands use. */
import { resolveSession } from '../session.js';
import { loadTask } from '../task/intake.js';
import { loadJudge } from '../judge/judge.js';
import { quickChecks } from '../judge/quickcheck.js';
import { readFlags } from '../commands/statusline.js';
import { fmtUsd } from '../cost/pricing.js';
import { packageVersion } from '../cli.js';

type Json = Record<string, unknown>;

const TOOLS = [
  {
    name: 'tally_task',
    description: "The frozen acceptance criteria for the current Claude Code session's task, with each criterion's current status from Tally's quick mechanical checks against the working tree. Call it before saying a task is done.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'tally_unmet',
    description: 'Only the criteria that are not yet met: mechanical checks that currently fail (with what is missing) and judgment criteria the Judge will read. Empty means every mechanical check passes.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'tally_receipt',
    description: "The latest receipt for this session if one exists: verdict, completion, cost, and each criterion's status with evidence.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'tally_flags',
    description: 'Coach flags waiting for a decision from the user (consent, confirmation, a file to write), with the command that resolves each.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

function text(s: string): Json {
  return { content: [{ type: 'text', text: s }] };
}

export function callTool(name: string, cwd: string): Json {
  const session = process.env.CLAUDE_SESSION_ID || resolveSession(undefined, cwd);
  if (!session) return text('Tally: no active session for this directory (hooks not installed, or no prompt yet).');
  if (name === 'tally_task' || name === 'tally_unmet') {
    const task = loadTask(session);
    if (!task) return text('Tally: no task linked yet. Link one with /tally:task <url|text> (or it will be inferred from the first prompt).');
    const p = quickChecks(session, cwd);
    const rows = p.items.filter((i) => name === 'tally_task' || i.status !== 'met');
    const L = [`Task: ${task.title}${task.inferred && !task.confirmed ? ' (inferred, unconfirmed)' : ''} · budget ${fmtUsd(task.budget_usd)}`, `Mechanical checks: ${p.met}/${p.checked} met (${p.total - p.checked} need the Judge)`, ''];
    for (const i of rows) L.push(`${i.status === 'met' ? '✔' : i.status === 'unmet' ? '✘' : '?'} ${i.id} ${i.text} — ${i.why}`);
    if (name === 'tally_unmet' && !rows.some((i) => i.status === 'unmet')) L.push('Every mechanical check passes. Judgment criteria are decided at judge time from the evidence.');
    return text(L.join('\n'));
  }
  if (name === 'tally_receipt') {
    const j = loadJudge(session);
    if (!j) return text('Tally: no receipt yet for this session; it is produced on push, at session end, or with /tally:judge.');
    const L = [`${j.verdict.verdict.toUpperCase()} · ${j.completion_pct}% complete${j.completion_basis && j.completion_basis.verifiable < j.completion_basis.total ? ` (${j.counts.unverifiable} unverifiable)` : ''} · quality ${j.quality.score}/10 · ${fmtUsd(j.cost.total_usd)}`];
    for (const c of j.criteria) L.push(`${c.override?.status ?? c.status} ${c.id} ${c.text} — ${c.evidence.slice(0, 160)}`);
    return text(L.join('\n'));
  }
  if (name === 'tally_flags') {
    const flags = readFlags(session).pending;
    if (!flags.length) return text('No Coach flags waiting.');
    return text(flags.map((f) => `${f.title}${f.label ? ` [${f.label}]` : ''} → tally coach --apply ${f.rule}`).join('\n'));
  }
  return text(`Unknown tool ${name}`);
}

function handle(msg: { id?: number | string; method?: string; params?: Json }, cwd: string): Json | null {
  const reply = (result: Json) => ({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize':
      return reply({ protocolVersion: (msg.params?.protocolVersion as string) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'tally', version: packageVersion() } });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = String((msg.params?.name as string) ?? '');
      try {
        return reply(callTool(name, cwd));
      } catch (err) {
        return reply({ ...text(`Tally error: ${err instanceof Error ? err.message : String(err)}`), isError: true });
      }
    }
    default:
      if (msg.id === undefined) return null; /* notifications need no reply */
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }
}

export function serve(cwd = process.cwd()): void {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buf += chunk;
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) {
        try {
          const out = handle(JSON.parse(line) as { id?: number; method?: string; params?: Json }, cwd);
          if (out) process.stdout.write(JSON.stringify(out) + '\n');
        } catch (err) {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `Parse error: ${String(err).slice(0, 100)}` } }) + '\n');
        }
      }
      nl = buf.indexOf('\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));
}
