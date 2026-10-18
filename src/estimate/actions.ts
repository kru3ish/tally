/* The cost check as a short, ranked to-do list: one action per fix, in plain words, with the most it could save, why,
   and the one command that applies it. The terminal, the dashboard and /tally:cost all show this same list. */
import { spawnSync } from 'node:child_process';
import { builtCliPath } from '../paths.js';
import type { AltTool, CostCheck, Fix } from './variance.js';

export type ActionKind = 'setting' | 'plugin' | 'skill' | 'subagent' | 'notes' | 'command' | 'habit';

export interface Action {
  id: string;
  title: string;
  kind: ActionKind;
  /* who made it: Tally writes it, or it is an official / community tool that already exists */
  source: 'tally' | 'official' | 'community';
  usd: number;
  why: string;
  /* the line to run; absent for a habit */
  command?: string;
  /* true when `tally fix <id>` applies it (settings, files, CLAUDE.md, official plugin installs) */
  tallyFix: boolean;
  others: AltTool[];
}

const PLAIN: Record<string, { title: string; kind: ActionKind }> = {
  'model-sonnet': { title: 'Use Sonnet by default', kind: 'setting' },
  'subagent-sonnet': { title: 'Run subagents on Sonnet', kind: 'setting' },
  'compact-window': { title: 'Compact the context at 200k tokens', kind: 'setting' },
  'bash-output-cap': { title: 'Cap command output at 15k characters', kind: 'setting' },
  'mcp-output-cap': { title: 'Cap MCP tool output at 10k tokens', kind: 'setting' },
  'effort-medium': { title: 'Default to medium effort', kind: 'setting' },
  'claude-md': { title: 'Write the working commands into CLAUDE.md', kind: 'notes' },
  scout: { title: 'Add a Haiku scout subagent for exploring', kind: 'subagent' },
  'story-skill': { title: 'Save this story as a project skill', kind: 'skill' },
  'run-tests-skill': { title: 'Add a quiet run-tests skill', kind: 'skill' },
  'drop-unused-mcp': { title: 'Turn off plugins and MCP servers you did not use', kind: 'command' },
  'split-story': { title: 'Split stories this size into sessions', kind: 'habit' },
};

let cachedCli: string | undefined;
/* `tally` when it is on PATH; otherwise the full node command, so a plugin-only install can paste it too */
export function cliCommand(): string {
  if (cachedCli) return cachedCli;
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['tally'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
  cachedCli = r.status === 0 && r.stdout.trim() ? 'tally' : `node "${builtCliPath().replace(/\\/g, '/')}"`;
  return cachedCli;
}

export function isOfficialInstall(f: Fix): boolean {
  return f.apply.kind === 'command' && f.apply.commands.length > 0 && f.apply.commands.every((c) => /^claude plugin install [\w.-]+@claude-plugins-official$/.test(c));
}

/* the first sentence (a full stop before a capital letter, not "e.g."), kept whole when it is short enough */
export function firstSentence(s: string): string {
  const m = /^(.+?\.)(?=\s+\S|\s*$)/.exec(s.replace(/\be\.g\./g, 'e\u2024g\u2024'));
  let out = (m ? m[1]! : s).replace(/e\u2024g\u2024/g, 'e.g.');
  if (out.length > 200) out = out.slice(0, 200).replace(/\s+\S*$/, '') + '…';
  return out.charAt(0).toUpperCase() + out.slice(1);
}

export function buildActions(c: CostCheck, cli = 'tally'): Action[] {
  const byFix = new Map<string, Action>();
  for (const d of c.drivers) {
    const f = d.fix;
    if (!f) continue;
    const existing = byFix.get(f.id);
    if (existing) {
      existing.usd = Math.max(existing.usd, d.usd);
      continue;
    }
    const official = isOfficialInstall(f);
    const plain = PLAIN[f.id];
    const pluginName = official ? /install ([\w.-]+)@/.exec((f.apply as { commands: string[] }).commands[0]!)?.[1] : undefined;
    const kind: ActionKind = official ? 'plugin' : plain?.kind ?? (f.apply.kind === 'settings' ? 'setting' : f.apply.kind === 'file' ? 'skill' : f.apply.kind === 'claude_md' ? 'notes' : f.apply.kind === 'advice' ? 'habit' : 'command');
    const tallyFix = official || f.apply.kind === 'settings' || f.apply.kind === 'file' || f.apply.kind === 'claude_md';
    const command = f.apply.kind === 'advice' ? undefined : tallyFix ? `${cli} fix ${f.id}` : f.apply.kind === 'command' ? f.apply.commands.join(' && ') : undefined;
    byFix.set(f.id, {
      id: f.id,
      title: official ? `Install ${pluginName}` : plain?.title ?? f.title,
      kind,
      source: official ? 'official' : 'tally',
      usd: d.usd,
      why: firstSentence(d.detail),
      command,
      tallyFix,
      others: (d.alternatives ?? []).filter((a) => !pluginName || a.name !== pluginName).slice(0, 3),
    });
  }
  const order = (a: Action) => (a.kind === 'habit' ? 1 : 0);
  return [...byFix.values()].sort((a, b) => order(a) - order(b) || b.usd - a.usd);
}
