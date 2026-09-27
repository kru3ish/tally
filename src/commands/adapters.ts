/* `tally adapters [--json]`: which coding agents Tally can observe on this machine, whether their hooks are installed,
   and what each one can and cannot tell Tally. Nothing is estimated: a capability an agent does not expose is shown as
   unavailable, and that is exactly what its receipts will say. */
import fs from 'node:fs';
import { type Args, has } from '../cli.js';
import { AGENT_IDS, agent, type AgentCapabilities } from '../agents/index.js';
import { isInstalled } from '../install/install.js';

const CAP_LABEL: Array<[keyof AgentCapabilities, string]> = [
  ['lifecycle_hooks', 'lifecycle'],
  ['tool_calls', 'tool calls'],
  ['shell_commands', 'shell'],
  ['file_reads', 'reads'],
  ['file_edits', 'edits'],
  ['permission_hooks', 'deny'],
  ['stop_hook', 'stop'],
  ['context_events', 'context'],
  ['subagents', 'subagents'],
  ['transcript', 'transcript'],
  ['token_usage', 'tokens'],
  ['model_name', 'model'],
  ['cost', 'cost'],
];

export function adapterStatus(): Array<{ id: string; label: string; hooks_file: string; present: boolean; installed: boolean; capabilities: AgentCapabilities }> {
  return AGENT_IDS.map((id) => {
    const a = agent(id);
    const file = a.hooksFile();
    let installed = false;
    if (id === 'claude-code') installed = isInstalled('user');
    else if (fs.existsSync(file)) {
      try {
        const text = fs.readFileSync(file, 'utf8');
        installed = /--agent[ =]/.test(text) && /hook\.js|tally/.test(text);
      } catch {
        installed = false;
      }
    }
    return { id, label: a.label, hooks_file: file, present: fs.existsSync(file), installed, capabilities: a.capabilities };
  });
}

export async function run(args: Args): Promise<number | void> {
  const rows = adapterStatus();
  if (has(args, 'json')) {
    process.stdout.write(JSON.stringify({ schema: 'tally.adapters.v1', adapters: rows }, null, 2) + '\n');
    return;
  }
  const L: string[] = ['Agents Tally can observe', ''];
  for (const r of rows) {
    L.push(`${r.label.padEnd(12)} ${r.installed ? 'hooks installed' : r.present ? 'config present, Tally hooks not installed' : 'not detected'}  ${r.hooks_file}`);
    const yes = CAP_LABEL.filter(([k]) => r.capabilities[k] === true).map(([, l]) => l);
    const no = CAP_LABEL.filter(([k]) => r.capabilities[k] === false).map(([, l]) => l);
    L.push(`  can tell Tally:  ${yes.join(', ')}`);
    if (no.length) L.push(`  unavailable:     ${no.join(', ')}  (reported as unavailable on receipts, never estimated)`);
    if (r.capabilities.notes) L.push(`  note: ${r.capabilities.notes}`);
    L.push('');
  }
  L.push('Install into an agent: tally install --agent codex|gemini|cursor    Add one: docs/ADAPTER_SDK.md');
  process.stdout.write(L.join('\n') + '\n');
}
