/* The catalog of what already exists: plugins, skills, subagents and MCP servers other people have built and listed.
   When the cost check finds a pattern (docs looked up on the web, whole files read, a context that never compacts),
   it asks the catalog for the best existing tool for that need before falling back to a file Tally writes itself.

   Sources, fetched with plain GETs (nothing about the user, the repo or the session is sent) and cached in
   ~/.tally/catalog.json for a week:
     official  Anthropic's plugin marketplace (claude-plugins-official) and Anthropic's skills marketplace
     curated   awesome-claude-code, awesome-mcp-servers, awesome-claude-skills (community lists with human review)
   The open MCP registry is not used for ranking: it has no quality signal, and a search for "documentation" returned
   vendor-specific servers ahead of general ones. GitHub stars, when they can be fetched, break ties between curated
   entries. A listing is not an endorsement: every pick shows its source and is installed only by the user. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readJson, tallyHome, writeJson } from '../paths.js';

export type Tier = 'official' | 'curated';
export type Kind = 'plugin' | 'skill' | 'mcp' | 'agent' | 'tool';

export interface CatalogEntry {
  id: string;
  name: string;
  kind: Kind;
  tier: Tier;
  source: string;
  category?: string;
  description: string;
  url?: string;
  /* the one line that installs it, when the listing says how */
  install?: string;
  repo?: string;
  stars?: number;
}

export interface Catalog {
  fetched_at: string;
  sources: Array<{ name: string; url: string; entries: number; error?: string }>;
  entries: CatalogEntry[];
  stars?: Record<string, { stars: number; at: string }>;
}

export interface SourceDef {
  name: string;
  url: string;
  tier: Tier;
  parse: (body: string, src: SourceDef) => CatalogEntry[];
}

const clean = (s: string) =>
  s
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]+/g, '')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

const repoOf = (url: string | undefined) => /github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?(?:[/#?]|$)/.exec(url ?? '')?.[1];

function parseMarketplace(marketplace: string, kind: Kind) {
  return (body: string, src: SourceDef): CatalogEntry[] => {
    const d = JSON.parse(body) as { name?: string; plugins?: Array<{ name: string; description?: string; category?: string; homepage?: string; source?: unknown; skills?: string[] }> };
    const mk = d.name ?? marketplace;
    return (d.plugins ?? []).map((p) => {
      const s = p.source as { url?: string; repo?: string } | string | undefined;
      const url = p.homepage ?? (typeof s === 'object' ? s?.url ?? (s?.repo ? `https://github.com/${s.repo}` : undefined) : undefined);
      return { id: `${src.name}:${p.name}`, name: p.name, kind: p.skills ? 'skill' : kind, tier: src.tier, source: src.name, category: p.category, description: clean(p.description ?? ''), url, repo: repoOf(url), install: `claude plugin install ${p.name}@${mk}` };
    });
  };
}

/* "- [Name](url) ... - description" bullets under ## / ### headings; the heading is the category */
export function parseAwesome(kindFor: (heading: string) => Kind | null) {
  return (body: string, src: SourceDef): CatalogEntry[] => {
    const out: CatalogEntry[] = [];
    let heading = '';
    for (const line of body.split('\n')) {
      const h = /^#{2,3}\s+(.+)$/.exec(line);
      if (h) {
        heading = clean(h[1]!.replace(/<a [^>]*><\/a>/g, '')).replace(/^[^\w]+/, '');
        continue;
      }
      const m = /^\s*[-*]\s+\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)(.*)$/.exec(line);
      if (!m) continue;
      const kind = kindFor(heading);
      if (!kind) continue;
      const rest = m[3]!;
      const desc = clean(rest.replace(/^.*?\s[-–—:]\s/, ''));
      if (desc.length < 12) continue;
      const repo = repoOf(m[2]);
      const official = rest.includes('🎖');
      out.push({ id: `${src.name}:${repo ?? m[1]}`, name: clean(m[1]!), kind, tier: src.tier, source: src.name, category: heading, description: desc.slice(0, 400), url: m[2], repo, ...(official ? { install: undefined } : {}) });
    }
    return out;
  };
}

const SKIP_SECTIONS = /usage|cost|status line|alternative client|ticker|recently added|start here|contents|table of|legend|tutorial|learning|official doc|getting started|resources|article|aggregator/i;

export const SOURCES: SourceDef[] = [
  { name: 'anthropic-plugins', url: 'https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/.claude-plugin/marketplace.json', tier: 'official', parse: parseMarketplace('claude-plugins-official', 'plugin') },
  { name: 'anthropic-skills', url: 'https://raw.githubusercontent.com/anthropics/skills/main/.claude-plugin/marketplace.json', tier: 'official', parse: parseMarketplace('anthropic-agent-skills', 'skill') },
  {
    name: 'awesome-claude-code',
    url: 'https://raw.githubusercontent.com/hesreallyhim/awesome-claude-code/main/README.md',
    tier: 'curated',
    parse: parseAwesome((h) => (SKIP_SECTIONS.test(h) ? null : /skill/i.test(h) ? 'skill' : /agent|orchestrat|workflow|sdlc/i.test(h) ? 'agent' : /mcp/i.test(h) ? 'mcp' : 'tool')),
  },
  { name: 'awesome-mcp-servers', url: 'https://raw.githubusercontent.com/punkpeye/awesome-mcp-servers/main/README.md', tier: 'curated', parse: parseAwesome((h) => (SKIP_SECTIONS.test(h) || /aggregator/i.test(h) ? null : 'mcp')) },
  { name: 'awesome-claude-skills', url: 'https://raw.githubusercontent.com/travisvn/awesome-claude-skills/main/README.md', tier: 'curated', parse: parseAwesome((h) => (SKIP_SECTIONS.test(h) ? null : 'skill')) },
];

export function catalogFile(): string {
  return path.join(tallyHome(), 'catalog.json');
}

export function loadCatalog(): Catalog | null {
  return readJson<Catalog | null>(catalogFile(), null);
}

export function isStale(c: Catalog | null, maxAgeDays = 7, now = Date.now()): boolean {
  return !c || now - Date.parse(c.fetched_at) > maxAgeDays * 86400000;
}

export async function updateCatalog(opts: { fetchImpl?: typeof fetch; sources?: SourceDef[]; timeoutMs?: number } = {}): Promise<Catalog> {
  const f = opts.fetchImpl ?? fetch;
  const prev = loadCatalog();
  const results = await Promise.all(
    (opts.sources ?? SOURCES).map(async (src) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15000);
      try {
        const r = await f(src.url, { signal: ctrl.signal, headers: { 'user-agent': 'tally-catalog' } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const entries = src.parse(await r.text(), src);
        return { meta: { name: src.name, url: src.url, entries: entries.length }, entries };
      } catch (err) {
        /* a source that fails keeps its previous entries, so one outage does not empty the catalog */
        const kept = prev?.entries.filter((e) => e.source === src.name) ?? [];
        return { meta: { name: src.name, url: src.url, entries: kept.length, error: err instanceof Error ? err.message : String(err) }, entries: kept };
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  const seen = new Set<string>();
  const entries: CatalogEntry[] = [];
  for (const r of results)
    for (const e of r.entries) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      entries.push(e);
    }
  const c: Catalog = { fetched_at: new Date().toISOString(), sources: results.map((r) => r.meta), entries, stars: prev?.stars ?? {} };
  writeJson(catalogFile(), c);
  return c;
}

/* ------------------------------------------------------------------ ranking ------------------------------------- */

export interface Need {
  id: string;
  /* a pick must match at least one of these */
  must: string[];
  /* each extra match adds to the score */
  boost?: string[];
  kinds?: Kind[];
  /* a deterministic best answer, when one is known (an official LSP plugin for the repo's language) */
  prefer?: string[];
  avoid?: RegExp;
  /* this many boost terms must also match, so a single generic word ("tokens") is not enough */
  minBoost?: number;
  /* this many of the `must` terms (default one) */
  minMust?: number;
  /* the repo's languages and dependencies: a mention is a plus, a mention of a language the repo does not use a minus */
  stack?: string[];
}

const LANGS = ['rust', 'python', 'golang', 'java', 'kotlin', 'ruby', 'php', 'swift', 'c#', '.net', 'elixir', 'scala', 'dart', 'flutter', 'typescript', 'javascript'];

export interface Pick {
  entry: CatalogEntry;
  score: number;
  why: string;
}

const words = (s: string) => s.toLowerCase();

function hits(text: string, terms: string[]): string[] {
  const t = words(text);
  return terms.filter((term) => new RegExp(`(^|[^a-z0-9])${term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(t));
}

export function search(c: Catalog, need: Need, opts: { installed?: string[]; limit?: number } = {}): Pick[] {
  const installed = new Set((opts.installed ?? []).map((s) => s.toLowerCase()));
  const out: Pick[] = [];
  for (const e of c.entries) {
    if (need.kinds && !need.kinds.includes(e.kind)) continue;
    if (installed.has(e.name.toLowerCase())) continue;
    const text = `${e.name} ${e.description} ${e.category ?? ''}`;
    if (need.avoid?.test(text)) continue;
    const preferred = need.prefer?.includes(e.name);
    const must = hits(text, need.must);
    if ((must.length < (need.minMust ?? 1)) && !preferred) continue;
    const boost = hits(text, need.boost ?? []);
    if (!preferred && boost.length < (need.minBoost ?? 0)) continue;
    const inName = hits(e.name, [...need.must, ...(need.boost ?? [])]).length;
    const stack = need.stack ?? [];
    const stackHits = hits(text, stack).length;
    const foreign = stack.length ? hits(text, LANGS.filter((l) => !stack.includes(l))).length : 0;
    const stars = c.stars?.[e.repo ?? '']?.stars ?? e.stars;
    let score = must.length * 2 + boost.length * 1.5 + inName * 2 + stackHits * 2 - foreign * 4 + (e.tier === 'official' ? 4 : 0) + (stars ? Math.min(4, Math.log10(stars + 1)) : 0);
    if (preferred) score += 20;
    out.push({ entry: { ...e, ...(stars !== undefined ? { stars } : {}) }, score, why: [...new Set([...must, ...boost])].slice(0, 4).join(', ') });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 3);
}

/* GitHub stars for a shortlist, through `gh` when it is logged in (5000 requests/hour) or the public API (60/hour);
   cached in the catalog for 30 days. Best effort: no stars is not an error. */
export async function enrichStars(c: Catalog, repos: string[], opts: { fetchImpl?: typeof fetch; max?: number } = {}): Promise<number> {
  c.stars ??= {};
  const fresh = (r: string) => c.stars![r] && Date.now() - Date.parse(c.stars![r]!.at) < 30 * 86400000;
  const todo = [...new Set(repos)].filter((r) => r && !fresh(r)).slice(0, opts.max ?? 20);
  let got = 0;
  const gh = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8', timeout: 5000, windowsHide: true }).status === 0;
  for (const repo of todo) {
    let stars: number | undefined;
    if (gh) {
      const r = spawnSync('gh', ['api', `repos/${repo}`, '--jq', '.stargazers_count'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
      if (r.status === 0) stars = Number(r.stdout.trim());
    } else {
      try {
        const r = await (opts.fetchImpl ?? fetch)(`https://api.github.com/repos/${repo}`, { headers: { 'user-agent': 'tally-catalog', accept: 'application/vnd.github+json' } });
        if (r.ok) stars = ((await r.json()) as { stargazers_count?: number }).stargazers_count;
        else if (r.status === 403) break;
      } catch {
        break;
      }
    }
    if (typeof stars === 'number' && Number.isFinite(stars)) {
      c.stars[repo] = { stars, at: new Date().toISOString() };
      got += 1;
    }
  }
  if (got) writeJson(catalogFile(), c);
  return got;
}

export function fmtPick(p: Pick): string {
  const e = p.entry;
  const badge = e.tier === 'official' ? 'official' : `${e.source}${e.stars !== undefined ? `, ★${e.stars >= 1000 ? `${(e.stars / 1000).toFixed(1)}k` : e.stars}` : ''}`;
  return `${e.name} (${e.kind}, ${badge}): ${e.description.slice(0, 110)}${e.description.length > 110 ? '…' : ''}`;
}

export function catalogAgeDays(c: Catalog | null): number | null {
  return c ? Math.floor((Date.now() - Date.parse(c.fetched_at)) / 86400000) : null;
}

export function catalogExists(): boolean {
  return fs.existsSync(catalogFile());
}
