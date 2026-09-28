import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { type Args, has } from '../cli.js';
import { loadConfig, ConfigSchema } from '../config.js';
import { claudeHome, tallyHome, configFile, pricingFile, readJson, builtHookPath, packageRoot } from '../paths.js';
import { AGENT_IDS, agent } from '../agents/index.js';
import { loadPricing, bundledPricingPath } from '../cost/pricing.js';
import { isInstalled, settingsPath, isTallyHook } from '../install/install.js';
import { activeSessions } from '../session.js';
import { resolveClaudeBin } from '../llm/client.js';
import { loadHistory } from '../coach/context.js';
import { parseTranscriptFile } from '../transcript/parse.js';
import { projectTranscriptsDir, isInternalCwd } from '../paths.js';
import { ghStatus } from '../followup/gh.js';

export interface Check {
  name: string;
  ok: boolean | 'warn';
  detail: string;
  /* the command or link that resolves a failed or warned check; every non-ok check should carry one */
  fix?: string;
}

/* offline: skip the registry version check (also skipped under CI and TALLY_OFFLINE=1) */
export interface DoctorOptions {
  offline?: boolean;
  cwd?: string;
}

function semverNewer(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return false;
}

/* the installed Tally: version, where it runs from, whether `tally` on PATH is this one, and whether npm has a newer one */
function installChecks(opts: DoctorOptions): Check[] {
  const out: Check[] = [];
  const version = readJson<{ version?: string }>(path.join(packageRoot(), 'package.json'), {}).version ?? 'unknown';
  const here = packageRoot();
  const onPath = sh(process.platform === 'win32' ? 'where' : 'which', ['tally']);
  const first = onPath.ok ? onPath.out.split('\n')[0]!.trim() : '';
  let resolvesHere: boolean | null = null;
  if (first) {
    try {
      /* npm's shim (tally.cmd / a shell script) references the package; a symlink resolves to it */
      const real = fs.realpathSync(first);
      const text = real.endsWith('.js') ? '' : fs.readFileSync(first, 'utf8');
      resolvesHere = real.startsWith(here) || text.includes(path.basename(here)) || text.includes('@kru3ish/tally') || text.includes('dist/cli.js') || text.includes('dist\\cli.js');
    } catch {
      resolvesHere = null;
    }
  }
  const prefix = sh('npm', ['prefix', '-g']);
  const globalBin = prefix.ok ? (process.platform === 'win32' ? prefix.out.trim() : path.join(prefix.out.trim(), 'bin')) : '';
  out.push({
    name: 'tally',
    ok: first ? (resolvesHere === false ? 'warn' : true) : 'warn',
    detail: `${version} at ${here}${first ? `; \`tally\` on PATH → ${first}${resolvesHere === false ? ' (a different install)' : ''}` : '; `tally` is not on PATH'}`,
    fix: first ? (resolvesHere === false ? `two installs: \`npm ls -g @kru3ish/tally\` shows the global one; remove the other or use the one on PATH` : undefined) : `add npm's global bin directory to PATH${globalBin ? ` (${globalBin})` : ''}, or run \`npm i -g @kru3ish/tally\``,
  });
  const skip = opts.offline || process.env.CI || process.env.TALLY_OFFLINE === '1' || process.env.TALLY_INTERNAL === '1';
  if (skip) out.push({ name: 'update', ok: true, detail: `registry check skipped (${opts.offline ? '--offline' : process.env.CI ? 'CI' : 'TALLY_OFFLINE / internal run'})` });
  else {
    const r = process.platform === 'win32' ? spawnSync('npm view @kru3ish/tally version', { encoding: 'utf8', shell: true, windowsHide: true, timeout: 6000 }) : spawnSync('npm', ['view', '@kru3ish/tally', 'version'], { encoding: 'utf8', windowsHide: true, timeout: 6000 });
    const latest = r.status === 0 ? (r.stdout ?? '').trim().split('\n').pop()?.trim() ?? '' : '';
    if (!/^\d+\.\d+\.\d+/.test(latest)) out.push({ name: 'update', ok: true, detail: 'could not reach the npm registry (offline?); skipped' });
    else if (semverNewer(latest, version)) out.push({ name: 'update', ok: 'warn', detail: `${latest} is on npm, this is ${version}`, fix: `npm i -g @kru3ish/tally@${latest}   (plugin users: /plugin update tally@tally)` });
    else out.push({ name: 'update', ok: true, detail: `${version} is the latest on npm${semverNewer(version, latest) ? ` (registry has ${latest}; this is a local build)` : ''}` });
  }
  return out;
}

/* which supported agents are on this machine, whether Tally's hooks are in each, and whether their history is readable */
function agentChecks(): Check[] {
  const out: Check[] = [];
  const detected: string[] = [];
  const absent: string[] = [];
  for (const id of AGENT_IDS) {
    const a = agent(id);
    const hooksFile = a.hooksFile();
    const configDir = path.dirname(hooksFile);
    const binary = id === 'claude-code' ? sh('claude', ['--version']).ok : id === 'codex' ? sh(process.platform === 'win32' ? 'where' : 'which', ['codex']).ok : id === 'gemini' ? sh(process.platform === 'win32' ? 'where' : 'which', ['gemini']).ok : sh(process.platform === 'win32' ? 'where' : 'which', ['cursor-agent']).ok || fs.existsSync(configDir);
    const present = binary || fs.existsSync(configDir);
    if (!present) {
      absent.push(a.label);
      continue;
    }
    detected.push(a.label);
    let installed = false;
    if (id === 'claude-code') {
      const settings = readJson<{ enabledPlugins?: Record<string, boolean> }>(hooksFile, {});
      installed = isInstalled('user') || Object.entries(settings.enabledPlugins ?? {}).some(([k, v]) => v && k.startsWith('tally'));
    } else if (fs.existsSync(hooksFile)) {
      try {
        const text = fs.readFileSync(hooksFile, 'utf8');
        installed = /--agent[ =]/.test(text) && /hook\.js|tally/.test(text);
      } catch {
        installed = false;
      }
    }
    out.push({ name: `hooks: ${id}`, ok: installed ? true : 'warn', detail: installed ? `Tally hooks in ${hooksFile}` : `${a.label} detected (${binary ? 'binary on PATH' : configDir}) but Tally is not hooked in`, fix: installed ? undefined : id === 'claude-code' ? '`tally install` or /plugin install tally@tally' : `tally install --agent ${id}` });
    /* history: where the agent keeps transcripts, and whether Tally can read them */
    const roots: string[] = id === 'claude-code' ? [path.join(claudeHome(), 'projects')] : ((a as { transcriptRoots?: () => string[] }).transcriptRoots?.() ?? []);
    if (!roots.length) out.push({ name: `history: ${id}`, ok: true, detail: `${a.label} exposes no transcript to Tally; receipts say "unavailable" for tokens and cost (see tally adapters)` });
    else {
      const readable = roots.filter((r) => {
        try {
          fs.accessSync(r, fs.constants.R_OK);
          return fs.statSync(r).isDirectory();
        } catch {
          return false;
        }
      });
      let files = 0;
      for (const r of readable) {
        try {
          const walk = (d: string, depth: number): void => {
            if (depth > 4 || files > 5000) return;
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
              if (e.isDirectory()) walk(path.join(d, e.name), depth + 1);
              else if (e.name.endsWith('.jsonl')) files += 1;
            }
          };
          walk(r, 0);
        } catch {
          /* unreadable subtree */
        }
      }
      out.push({ name: `history: ${id}`, ok: readable.length ? true : 'warn', detail: readable.length ? `${readable.join(', ')} readable (${files} transcript file(s))` : `${roots.join(', ')} not found or not readable`, fix: readable.length ? undefined : `run one ${a.label} session first; Tally reads transcripts from there and never writes to them` });
    }
  }
  out.unshift({ name: 'agents', ok: detected.length ? true : 'warn', detail: detected.length ? `detected: ${detected.join(', ')}${absent.length ? `; not detected: ${absent.join(', ')}` : ''}` : `no supported agent detected (${absent.join(', ')})`, fix: detected.length ? undefined : 'install Claude Code, Codex CLI, Gemini CLI or Cursor; Tally observes those' });
  return out;
}

function sh(bin: string, args: string[]): { ok: boolean; out: string } {
  const r = process.platform === 'win32' ? spawnSync(`${bin} ${args.join(' ')}`, { encoding: 'utf8', shell: true, windowsHide: true, timeout: 15000 }) : spawnSync(bin, args, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  return { ok: r.status === 0, out: ((r.stdout ?? '') + (r.stderr ?? '')).trim() };
}

export function runChecks(opts: DoctorOptions = {}): Check[] {
  const checks: Check[] = [];
  const major = Number(process.versions.node.split('.')[0]);
  checks.push({ name: 'node', ok: major >= 18, detail: `v${process.versions.node}${major >= 18 ? '' : ' (need >= 18)'}`, fix: major >= 18 ? undefined : 'install Node 18 or newer (https://nodejs.org) and reopen the terminal' });
  checks.push(...installChecks(opts));

  const claude = sh('claude', ['--version']);
  checks.push({ name: 'claude', ok: claude.ok, detail: claude.ok ? claude.out.split('\n')[0]! : 'not found on PATH; Tally needs the Claude Code CLI for judge/intake calls', fix: claude.ok ? undefined : 'install Claude Code (https://docs.claude.com/en/docs/claude-code/setup), run `claude` once to log in, then reopen the terminal' });
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
  checks.push({ name: 'hooks', ok: ways.length === 1 ? true : ways.length === 0 ? false : 'warn', detail: ways.length === 0 ? `not installed (${settingsPath('user')})` : ways.length === 1 ? `installed via ${ways[0]}` : `installed ${ways.length} ways (${ways.join(', ')}); tool events are de-duplicated by tool_use_id but prompts and stops are recorded twice`, fix: ways.length === 0 ? '`tally install` (npm CLI) or /plugin install tally@tally (plugin)' : ways.length > 1 ? 'keep one: `tally uninstall` removes the settings hooks, /plugin uninstall tally removes the plugin' : undefined });
  checks.push(...agentChecks());

  /* a hook whose script moved (a rebuild, an npm update, a deleted checkout) fails on every event without blocking the session */
  const referenced: string[] = [];
  for (const f of [settingsPath('user'), settingsPath('project', process.cwd())]) {
    const st = readJson<{ hooks?: Record<string, Array<{ hooks?: Array<{ command?: string; args?: string[] }> }>> }>(f, {});
    for (const groups of Object.values(st.hooks ?? {})) for (const g of groups) for (const h of g.hooks ?? []) if (isTallyHook(h)) referenced.push((h.args?.[0] ?? /"([^"]+hook\.js)"/.exec(h.command ?? '')?.[1] ?? '').replace(/^\$\{CLAUDE_PLUGIN_ROOT\}.*/, ''));
  }
  const missing = [...new Set(referenced.filter((p) => p && !fs.existsSync(p)))];
  if (referenced.length) checks.push({ name: 'hook script', ok: missing.length ? false : true, detail: missing.length ? `${missing.join(', ')} does not exist; every hook event is failing (non-blocking)` : `${[...new Set(referenced)].join(', ')} exists`, fix: missing.length ? `\`tally install\` repoints the hooks at ${builtHookPath()}` : undefined });

  const hook = builtHookPath();
  fs.mkdirSync(tallyHome(), { recursive: true });
  if (fs.existsSync(hook)) {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [hook, 'Stop'], { input: '{}', encoding: 'utf8', env: { ...process.env, TALLY_HOME: fs.mkdtempSync(path.join(tallyHome(), 'doctor-')) } });
    const ms = Date.now() - t0;
    checks.push({ name: 'hook runtime', ok: r.status === 0 && ms < 150 ? true : r.status === 0 ? 'warn' : false, detail: `exit ${r.status}, ${ms} ms (limit 150)`, fix: r.status === 0 ? (ms < 150 ? undefined : 'a slow disk or antivirus scan of node; run `tally doctor` again when the machine is idle') : `the hook crashed: run \`node "${hook}" Stop\` with input {} to see the error, then \`npm i -g @kru3ish/tally\` to reinstall` });
    for (const d of fs.readdirSync(tallyHome()).filter((x) => x.startsWith('doctor-'))) fs.rmSync(path.join(tallyHome(), d), { recursive: true, force: true });
  } else {
    checks.push({ name: 'hook runtime', ok: false, detail: 'dist/hook.js missing', fix: 'from a checkout: `npm run build`; from npm: `npm i -g @kru3ish/tally` again' });
  }

  try {
    fs.mkdirSync(tallyHome(), { recursive: true });
    fs.accessSync(tallyHome(), fs.constants.W_OK);
    checks.push({ name: 'data dir', ok: true, detail: tallyHome() });
  } catch {
    checks.push({ name: 'data dir', ok: false, detail: `${tallyHome()} not writable`, fix: `make it writable, or point TALLY_HOME at a directory you own` });
  }

  const cfgRaw = readJson<unknown>(configFile(), null);
  const cfgOk = cfgRaw === null || ConfigSchema.safeParse(cfgRaw).success;
  const cfg = loadConfig();
  checks.push({ name: 'config', ok: cfgOk, detail: cfgOk ? `hourly_rate $${cfg.hourly_rate}, judge ${cfg.models.judge}, coach ${cfg.models.coach}, auto_apply ${cfg.auto_apply}, writeback ${cfg.writeback}` : `${configFile()} is invalid; defaults in use`, fix: cfgOk ? undefined : `fix or delete ${configFile()}; \`tally config\` shows the valid keys` });

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

export function doctorJson(checks: Check[]): { schema: 'tally.doctor.v1'; version: string; platform: string; node: string; ok: boolean; problems: number; warnings: number; checks: Array<{ name: string; status: 'ok' | 'warn' | 'fail'; detail: string; fix?: string }> } {
  const version = readJson<{ version?: string }>(path.join(packageRoot(), 'package.json'), {}).version ?? 'unknown';
  const rows = checks.map((c) => ({ name: c.name, status: (c.ok === true ? 'ok' : c.ok === 'warn' ? 'warn' : 'fail') as 'ok' | 'warn' | 'fail', detail: c.detail, ...(c.fix ? { fix: c.fix } : {}) }));
  const problems = rows.filter((r) => r.status === 'fail').length;
  return { schema: 'tally.doctor.v1', version, platform: `${process.platform} ${os.release()}`, node: process.versions.node, ok: problems === 0, problems, warnings: rows.filter((r) => r.status === 'warn').length, checks: rows };
}

export async function run(args: Args): Promise<number | void> {
  const checks = runChecks({ offline: has(args, 'offline') });
  if (has(args, 'json')) {
    const j = doctorJson(checks);
    process.stdout.write(JSON.stringify(j, null, 2) + '\n');
    return j.ok ? 0 : 1;
  }
  const color = !has(args, 'plain');
  const mark = (ok: boolean | 'warn') => (ok === true ? (color ? '\x1b[32m✔\x1b[0m' : 'ok  ') : ok === 'warn' ? (color ? '\x1b[33m!\x1b[0m' : 'warn') : color ? '\x1b[31m✘\x1b[0m' : 'FAIL');
  const dim = (s: string) => (color ? `\x1b[90m${s}\x1b[0m` : s);
  for (const c of checks) {
    process.stdout.write(`${mark(c.ok)} ${c.name.padEnd(18)} ${c.detail}\n`);
    if (c.ok !== true && c.fix) process.stdout.write(`${' '.repeat(color ? 2 : 5)}${dim(`fix: ${c.fix}`)}\n`);
  }
  const failed = checks.filter((c) => c.ok === false).length;
  const warned = checks.filter((c) => c.ok === 'warn').length;
  process.stdout.write(failed ? `\n${failed} problem(s)${warned ? `, ${warned} warning(s)` : ''}. Paste \`tally doctor --json\` into an issue: https://github.com/kru3ish/tally/issues/new\n` : `\nAll good${warned ? ` (${warned} optional item(s) not set up)` : ''}.\n`);
  return failed ? 1 : 0;
}
