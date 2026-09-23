import { type Args, has } from '../cli.js';
import { install, uninstall, isInstalled, PluginConflictError } from '../install/install.js';
import { ensureDir, tallyHome, pricingFile } from '../paths.js';
import fs from 'node:fs';
import { bundledPricingPath } from '../cost/pricing.js';
import { saveConfig } from '../config.js';

export async function run(args: Args): Promise<number | void> {
  const scope = has(args, 'project') ? 'project' : 'user';
  ensureDir(tallyHome());
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
  if (!isInstalled(scope, process.cwd())) {
    process.stdout.write(`No Tally hooks found in ${scope} settings.\n`);
  }
  const r = uninstall({ scope, cwd: process.cwd() });
  process.stdout.write(`Removed ${r.removed} hook(s) from ${r.file}${r.restoredOriginal ? ' (original bytes restored)' : ''}\n`);
}
