/* `tally catalog`: the list of plugins, skills, subagents and MCP servers that already exist (Anthropic's official
   marketplaces and the curated awesome lists), cached locally and used by the cost check to recommend an existing
   tool before writing one. `update` fetches it (plain GETs, nothing about you is sent), `search` queries it. */
import { type Args, flag, has } from '../cli.js';
import { catalogAgeDays, enrichStars, fmtPick, loadCatalog, search, updateCatalog, type Kind } from '../catalog/catalog.js';
import { stackOf, stackPicks } from '../catalog/needs.js';
import { repoRoot } from '../estimate/ledger.js';

export async function run(args: Args): Promise<number | void> {
  const sub = args._[0] ?? 'status';
  if (sub === 'update') {
    const c = await updateCatalog();
    for (const s of c.sources) process.stdout.write(`${s.error ? '✗' : '✓'} ${s.name.padEnd(22)} ${String(s.entries).padStart(5)} entries${s.error ? `  (${s.error}; kept the previous copy)` : ''}\n`);
    process.stdout.write(`${c.entries.length} entries cached in the catalog. Nothing about you, your repo or your sessions was sent.\n`);
    return c.sources.every((s) => s.error) ? 1 : 0;
  }
  const c = loadCatalog();
  if (!c) {
    process.stderr.write('No catalog yet. Run: tally catalog update\n');
    return 1;
  }
  if (sub === 'search') {
    const terms = args._.slice(1).join(' ').toLowerCase().split(/[,\s]+/).filter((t) => t.length > 1);
    if (!terms.length) {
      process.stderr.write('Usage: tally catalog search <words> [--kind plugin|skill|mcp|agent|tool]\n');
      return 2;
    }
    const stack = stackOf(repoRoot(process.cwd()));
    const kind = flag(args, 'kind') as Kind | undefined;
    const q = (minMust: number) => search(c, { id: 'q', must: terms, boost: [], minMust, kinds: kind ? [kind] : undefined, stack: [...stack.languages, ...stack.deps] }, { limit: Number(flag(args, 'limit') ?? 10) });
    /* every word first; if nothing has all of them, most of them */
    let picks = q(terms.length);
    if (!picks.length && terms.length > 1) picks = q(Math.ceil(terms.length / 2));
    if (has(args, 'stars')) {
      await enrichStars(c, picks.map((p) => p.entry.repo ?? '').filter(Boolean));
      return run({ _: args._, flags: { ...args.flags, stars: false } });
    }
    for (const p of picks) process.stdout.write(`${fmtPick(p)}\n    ${p.entry.install ?? p.entry.url ?? ''}\n`);
    if (!picks.length) process.stdout.write('Nothing matched.\n');
    return;
  }
  const age = catalogAgeDays(c);
  process.stdout.write(`Catalog: ${c.entries.length} entries, fetched ${age === 0 ? 'today' : `${age} day(s) ago`}${(age ?? 0) > 7 ? ' (stale: tally catalog update)' : ''}\n`);
  for (const s of c.sources) process.stdout.write(`  ${s.name.padEnd(22)} ${String(s.entries).padStart(5)}${s.error ? `  last fetch failed: ${s.error}` : ''}\n`);
  const stack = stackOf(repoRoot(process.cwd()));
  if (stack.languages.length) process.stdout.write(`This repo: ${stack.languages.join(', ')}${stack.deps.length ? `; ${stack.deps.length} dependencies` : ''}\n`);
  const picks = stackPicks(c, stack, []);
  if (picks.length) process.stdout.write(`Official plugins for this repo's stack: ${picks.map((p) => `${p.name} (${p.install})`).join(', ')}\n`);
}
