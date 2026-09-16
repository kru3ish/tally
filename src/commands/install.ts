import { type Args, has } from '../cli.js';
import { install, uninstall, isInstalled } from '../install/install.js';
import { ensureDir, tallyHome, pricingFile } from '../paths.js';
import fs from 'node:fs';
import { bundledPricingPath } from '../cost/pricing.js';
import { saveConfig } from '../config.js';

export async function run(args: Args): Promise<void> {
  const scope = has(args, 'project') ? 'project' : 'user';
  ensureDir(tallyHome());
  if (!fs.existsSync(pricingFile())) fs.copyFileSync(bundledPricingPath(), pricingFile());
  saveConfig({});
  const r = install({ scope, cwd: process.cwd() });
  process.stdout.write(`Installed ${r.added} hook group(s) into ${r.file}\n`);
  if (r.backup) process.stdout.write(`Backup: ${r.backup}\n`);
  process.stdout.write(`Data dir: ${tallyHome()}\nNext: run \`tally start\` beside a Claude Code session, or \`tally doctor\`.\n`);
}

export async function runUninstall(args: Args): Promise<void> {
  const scope = has(args, 'project') ? 'project' : 'user';
  if (!isInstalled(scope, process.cwd())) {
    process.stdout.write(`No Tally hooks found in ${scope} settings.\n`);
  }
  const r = uninstall({ scope, cwd: process.cwd() });
  process.stdout.write(`Removed ${r.removed} hook(s) from ${r.file}${r.restoredOriginal ? ' (original bytes restored)' : ''}\n`);
}
