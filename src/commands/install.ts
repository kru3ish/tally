import path from 'node:path';
import { type Args, flag, has } from '../cli.js';
import { agent, AGENT_IDS, type AgentId } from '../agents/index.js';
import { install, uninstall, isInstalled, PluginConflictError, backup, hookScriptPath } from '../install/install.js';
import { ensureDir, tallyHome, pricingFile } from '../paths.js';
import fs from 'node:fs';
import { bundledPricingPath } from '../cost/pricing.js';
import { saveConfig } from '../config.js';

/* `tally install --agent codex|gemini|cursor`: write Tally's hooks into that agent's hook file (backed up first). */
export function installAgent(id: string, scriptPath = hookScriptPath()): { file: string; backup: string | null; events: number } {
  const a = agent(id);
  if (a.id === 'claude-code') throw new Error('use `tally install` (no --agent) for Claude Code');
  const file = a.hooksFile();
  ensureDir(path.dirname(file));
  const bk = backup(file, `agent-${a.id}`);
  let existing: unknown = {};
  if (fs.existsSync(file)) {
    try {
      existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw new Error(`${file} is not valid JSON; fix it (or move it aside) before installing`);
    }
  }
  const doc = a.writeHooks(existing, (event) => `node "${scriptPath}" ${event} --agent ${a.id}`);
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  return { file, backup: bk, events: a.subscribed.length };
}

export function uninstallAgent(id: string): { file: string; removed: boolean } {
  const a = agent(id);
  const file = a.hooksFile();
  if (!fs.existsSync(file)) return { file, removed: false };
  const existing = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  const doc = a.removeHooks(existing);
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  return { file, removed: true };
}

export async function run(args: Args): Promise<number | void> {
  const scope = has(args, 'project') ? 'project' : 'user';
  ensureDir(tallyHome());
  const agentId = flag(args, 'agent');
  if (agentId && agentId !== 'claude-code') {
    if (!AGENT_IDS.includes(agentId as AgentId)) {
      process.stderr.write(`Unknown agent "${agentId}". Known: ${AGENT_IDS.join(', ')}
`);
      return 1;
    }
    if (!fs.existsSync(pricingFile())) fs.copyFileSync(bundledPricingPath(), pricingFile());
    saveConfig({});
    const r = installAgent(agentId);
    const a = agent(agentId);
    process.stdout.write(`Installed Tally hooks for ${a.label}: ${r.events} event(s) in ${r.file}
`);
    if (r.backup) process.stdout.write(`Backup: ${r.backup}
`);
    process.stdout.write(`Sessions, receipts and the Coach work the same as with Claude Code; the Judge and Coach call the model set in tally config (Claude through claude -p by default; any OpenAI-compatible endpoint with models.provider).${agentId === 'codex' ? ' Codex transcripts under ~/.codex/sessions are read for token usage and cost.' : ' Cost is recorded when the agent exposes token usage; otherwise receipts show criteria, tests and waste without dollars.'}
Remove with: tally uninstall --agent ${agentId}
`);
    return;
  }
  if (!fs.existsSync(pricingFile())) fs.copyFileSync(bundledPricingPath(), pricingFile());
  saveConfig({});
  let r: ReturnType<typeof install>;
  try {
    r = install({ scope, cwd: process.cwd(), force: has(args, 'force') });
  } catch (err) {
    if (err instanceof PluginConflictError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
  process.stdout.write(`Installed ${r.added} hook group(s) into ${r.file}${r.statusline ? ' and the Tally status line' : ''}\n`);
  process.stdout.write('MCP server: run `tally mcp --install` so Claude can ask tally_unmet before saying a task is done.\n');
  try {
    const { buildOnboard, renderOnboard } = await import('./onboard.js');
    const r = buildOnboard('30d');
    if (r.sessions) process.stdout.write('\n' + renderOnboard(r) + '\n');
  } catch {
    /* the report is a bonus, never a failure */
  }
  if (r.backup) process.stdout.write(`Backup: ${r.backup}\n`);
  process.stdout.write(`Data dir: ${tallyHome()}\nThe Coach now runs on its own after every turn (autopilot) and the status line shows the task, spend and flags; \`tally watch\` opens the optional one-key pane. Check with \`tally doctor\`.\n`);
}

export async function runUninstall(args: Args): Promise<void> {
  const scope = has(args, 'project') ? 'project' : 'user';
  const agentId = flag(args, 'agent');
  if (agentId && agentId !== 'claude-code') {
    const r = uninstallAgent(agentId);
    process.stdout.write(r.removed ? `Removed Tally hooks from ${r.file}
` : `No hook file at ${r.file}
`);
    return;
  }
  if (!isInstalled(scope, process.cwd())) {
    process.stdout.write(`No Tally hooks found in ${scope} settings.\n`);
  }
  const r = uninstall({ scope, cwd: process.cwd() });
  process.stdout.write(`Removed ${r.removed} hook(s) from ${r.file}${r.restoredOriginal ? ' (original bytes restored)' : ''}\n`);
}
