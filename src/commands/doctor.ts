import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { type Args, has } from '../cli.js';
import { loadConfig, ConfigSchema } from '../config.js';
import { claudeHome, tallyHome, configFile, pricingFile, readJson, builtHookPath } from '../paths.js';
import { loadPricing, bundledPricingPath } from '../cost/pricing.js';
import { isInstalled, settingsPath } from '../install/install.js';
import { activeSessions } from '../session.js';
import { resolveClaudeBin } from '../llm/client.js';
import { loadHistory } from '../coach/context.js';
import { parseTranscriptFile } from '../transcript/parse.js';
import { projectTranscriptsDir, isInternalCwd } from '../paths.js';
import { ghStatus } from '../followup/gh.js';

interface Check {
  name: string;
  ok: boolean | 'warn';
  detail: string;
}

function sh(bin: string, args: string[]): { ok: boolean; out: string } {
  const r = process.platform === 'win32' ? spawnSync(`${bin} ${args.join(' ')}`, { encoding: 'utf8', shell: true, windowsHide: true, timeout: 15000 }) : spawnSync(bin, args, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  return { ok: r.status === 0, out: ((r.stdout ?? '') + (r.stderr ?? '')).trim() };
}

export function runChecks(): Check[] {
  const checks: Check[] = [];
  const major = Number(process.versions.node.split('.')[0]);
  checks.push({ name: 'node', ok: major >= 18, detail: `v${process.versions.node}${major >= 18 ? '' : ' (need >= 18)'}` });

  const claude = sh('claude', ['--version']);
  checks.push({ name: 'claude', ok: claude.ok, detail: claude.ok ? claude.out.split('\n')[0]! : 'not found on PATH; Tally needs the Claude Code CLI for judge/intake calls' });
  if (claude.ok) {
    const r = resolveClaudeBin();
    checks.push({ name: 'claude -p launcher', ok: true, detail: r.prefix.length ? `resolved shim → ${r.prefix[0]}` : r.bin });
  }

  const gh = ghStatus();
  checks.push({ name: 'gh', ok: gh.ok ? true : 'warn', detail: gh.ok ? 'authenticated' : `${gh.reason}. Fix: ${gh.fix}. Until then GitHub intake falls back to the prompt text, write-back and follow-up are skipped and say so.` });

  const user = isInstalled('user');
  const project = isInstalled('project', process.cwd());
  const settings = readJson<{ enabledPlugins?: Record<string, boolean> }>(path.join(claudeHome(), 'settings.json'), {});
  const plugin = Object.entries(settings.enabledPlugins ?? {}).some(([k, v]) => v && k.startsWith('tally'));
  const ways = [user && 'user settings', project && 'project settings', plugin && 'plugin'].filter(Boolean) as string[];
  checks.push({ name: 'hooks', ok: ways.length === 1 ? true : ways.length === 0 ? false : 'warn', detail: ways.length === 0 ? `not installed; run \`tally install\` or /plugin install tally@tally (${settingsPath('user')})` : ways.length === 1 ? `installed via ${ways[0]}` : `installed ${ways.length} ways (${ways.join(', ')}); tool events are de-duplicated by tool_use_id but prompts and stops are recorded twice. Keep one: \`tally uninstall\` removes the settings hooks, /plugin uninstall tally removes the plugin` });

  const hook = builtHookPath();
  fs.mkdirSync(tallyHome(), { recursive: true });
  if (fs.existsSync(hook)) {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [hook, 'Stop'], { input: '{}', encoding: 'utf8', env: { ...process.env, TALLY_HOME: fs.mkdtempSync(path.join(tallyHome(), 'doctor-')) } });
    const ms = Date.now() - t0;
    checks.push({ name: 'hook runtime', ok: r.status === 0 && ms < 150 ? true : r.status === 0 ? 'warn' : false, detail: `exit ${r.status}, ${ms} ms (limit 150)` });
    for (const d of fs.readdirSync(tallyHome()).filter((x) => x.startsWith('doctor-'))) fs.rmSync(path.join(tallyHome(), d), { recursive: true, force: true });
  } else {
    checks.push({ name: 'hook runtime', ok: false, detail: 'dist/hook.js missing; run npm run build' });
  }

  try {
    fs.mkdirSync(tallyHome(), { recursive: true });
    fs.accessSync(tallyHome(), fs.constants.W_OK);
    checks.push({ name: 'data dir', ok: true, detail: tallyHome() });
  } catch {
    checks.push({ name: 'data dir', ok: false, detail: `${tallyHome()} not writable` });
  }

  const cfgRaw = readJson<unknown>(configFile(), null);
  const cfgOk = cfgRaw === null || ConfigSchema.safeParse(cfgRaw).success;
  const cfg = loadConfig();
  checks.push({ name: 'config', ok: cfgOk, detail: cfgOk ? `hourly_rate $${cfg.hourly_rate}, judge ${cfg.models.judge}, coach ${cfg.models.coach}, auto_apply ${cfg.auto_apply}, writeback ${cfg.writeback}` : `${configFile()} is invalid; defaults in use` });

  const pricing = loadPricing();
  const age = (Date.now() - Date.parse(pricing.last_verified)) / 86400000;
  checks.push({ name: 'pricing', ok: age < 60 ? true : 'warn', detail: `${fs.existsSync(pricingFile()) ? pricingFile() : bundledPricingPath()} verified ${pricing.last_verified} (${Math.round(age)} days ago${age >= 60 ? '; re-check against the pricing page' : ''})` });

  const jira = !!(cfg.jira.base_url && cfg.jira.email && cfg.jira.api_token);
  checks.push({ name: 'jira', ok: jira ? true : 'warn', detail: jira ? cfg.jira.base_url! : 'JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN not set (optional)' });
  checks.push({ name: 'linear', ok: cfg.linear.api_key ? true : 'warn', detail: cfg.linear.api_key ? 'LINEAR_API_KEY set' : 'LINEAR_API_KEY not set (optional)' });

  const tmux = sh(process.platform === 'win32' ? 'where' : 'which', ['tmux']);
  checks.push({ name: 'tmux', ok: tmux.ok ? true : 'warn', detail: tmux.ok ? 'available; `tally start` opens a split' : 'not found; `tally start` prints the command to run in a second terminal' });

  const transcripts = path.join(claudeHome(), 'projects');
  checks.push({ name: 'transcripts', ok: fs.existsSync(transcripts) ? true : 'warn', detail: fs.existsSync(transcripts) ? transcripts : `${transcripts} not found yet (created by Claude Code on first session)` });
  const active = activeSessions();
  checks.push({ name: 'sessions', ok: true, detail: `${active.length} active` });

  const receipts = loadHistory().filter((h) => typeof h.tally_share_pct === 'number');
  if (receipts.length) {
    const avg = receipts.reduce((s, h) => s + (h.tally_share_pct ?? 0), 0) / receipts.length;
    checks.push({ name: 'tally overhead', ok: avg <= 5 ? true : 'warn', detail: `Tally's own LLM spend averages ${avg.toFixed(1)}% of session spend over ${receipts.length} receipt(s)${avg > 5 ? '; above the 5% target — use a smaller judge model (tally config models.judge sonnet) or judge less often' : ''}` });
  } else {
    checks.push({ name: 'tally overhead', ok: true, detail: 'no receipts yet; the share of session spend is reported on each receipt' });
  }

  checks.push(transcriptFormatCheck(process.cwd()));
  const internalDirs = fs.existsSync(transcripts) ? fs.readdirSync(transcripts).filter((d) => isInternalCwd(d)).length : 0;
  if (internalDirs) checks.push({ name: 'internal runs', ok: true, detail: `${internalDirs} empty project dir(s) from Tally's own headless runs under ~/.claude/projects (no transcripts; safe to delete)` });
  return checks;
}

export function transcriptFormatCheck(cwd: string): Check {
  const dirs = [projectTranscriptsDir(cwd), path.join(claudeHome(), 'projects')];
  const files: string[] = [];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    const entries = fs.readdirSync(d).map((f) => path.join(d, f));
    for (const e of entries) {
      if (e.endsWith('.jsonl')) files.push(e);
      else if (fs.statSync(e).isDirectory() && !isInternalCwd(e)) for (const f of fs.readdirSync(e)) if (f.endsWith('.jsonl')) files.push(path.join(e, f));
    }
    if (files.length) break;
  }
  const recent = files.map((f) => ({ f, m: fs.statSync(f).mtimeMs })).sort((a, b) => b.m - a.m).slice(0, 5);
  if (!recent.length) return { name: 'transcript format', ok: 'warn', detail: 'no transcripts found to check' };
  let unparseable = 0;
  let total = 0;
  const versions = new Set<string>();
  const unknownTypes = new Set<string>();
  let unknownVersion = false;
  for (const { f } of recent) {
    try {
      const t = parseTranscriptFile(f);
      unparseable += t.format.unparseable_lines;
      total += t.format.total_lines;
      if (t.format.version) versions.add(t.format.version);
      if (!t.format.known) unknownVersion = true;
      for (const u of t.format.unknown_types) unknownTypes.add(u);
    } catch {
      unparseable += 1;
    }
  }
  const ok = unparseable === 0 && !unknownVersion ? true : 'warn';
  return {
    name: 'transcript format',
    ok,
    detail: `${recent.length} recent transcript(s), Claude Code ${[...versions].join(', ') || 'unknown'}${unknownVersion ? ' (not a verified layout; costs will be marked partial)' : ''}, ${unparseable}/${total} unparseable lines${unknownTypes.size ? `, unknown line types: ${[...unknownTypes].join(', ')}` : ''}`,
  };
}

export async function run(args: Args): Promise<number | void> {
  const checks = runChecks();
  const color = !has(args, 'plain');
  const mark = (ok: boolean | 'warn') => (ok === true ? (color ? '\x1b[32m✔\x1b[0m' : 'ok  ') : ok === 'warn' ? (color ? '\x1b[33m!\x1b[0m' : 'warn') : color ? '\x1b[31m✘\x1b[0m' : 'FAIL');
  for (const c of checks) process.stdout.write(`${mark(c.ok)} ${c.name.padEnd(18)} ${c.detail}\n`);
  const failed = checks.filter((c) => c.ok === false).length;
  process.stdout.write(failed ? `\n${failed} problem(s).\n` : '\nAll good.\n');
  return failed ? 1 : 0;
}
