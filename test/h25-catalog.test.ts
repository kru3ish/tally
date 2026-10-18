import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { isolate, tmpDir, basicFixture } from './helpers.js';
import { SOURCES, parseAwesome, updateCatalog, loadCatalog, search, type Catalog, type CatalogEntry } from '../src/catalog/catalog.js';
import { alternativesFor, stackOf, stackPicks } from '../src/catalog/needs.js';
import { computeCheck, renderCheck } from '../src/estimate/variance.js';
import { parseTranscriptFile } from '../src/transcript/parse.js';
import { writeJson } from '../src/paths.js';

let iso: ReturnType<typeof isolate>;
beforeEach(() => {
  iso = isolate();
});
afterEach(() => iso.restore());

const MARKETPLACE = JSON.stringify({
  name: 'claude-plugins-official',
  plugins: [
    { name: 'context7', description: 'Upstash Context7 MCP server for up-to-date documentation lookup for any library.', category: 'development' },
    { name: 'microsoft-docs', description: 'Access official Microsoft documentation for Azure and .NET.', category: 'development' },
    { name: 'typescript-lsp', description: 'TypeScript/JavaScript language server for enhanced code intelligence', category: 'development' },
    { name: 'gopls-lsp', description: 'Go language server for code intelligence and refactoring', category: 'development' },
    { name: 'lumen', description: 'Precise local semantic code search via MCP. Indexes your codebase for search.', category: 'development' },
    { name: 'playwright', description: 'Browser automation and end-to-end testing MCP server by Microsoft.', category: 'testing' },
    { name: 'figma', description: 'Figma design platform integration. Read design tokens.', category: 'design' },
  ],
});
const AWESOME = `# Awesome
## Contents
- [Skills](#skills)
## Skills
- [Caveman](https://github.com/x/caveman) by [x](https://github.com/x) - A plugin that conserves message tokens by communicating tersely, which reduces output and saves context.
<img src="https://img.shields.io/x">
## Usage & Cost
- [ccusage](https://github.com/y/ccusage) by [y](https://github.com/y) - Usage dashboard for token spend and cost reporting.
### 🔗 <a name="aggregators"></a>Aggregators
- [z/agg](https://github.com/z/agg) 📇 - An aggregator of many other servers for every need.
### 💻 Developer Tools
- [d/distil](https://github.com/d/distil) 🎖️ 📇 - Reversibly compress large tool outputs into handles; track token savings.
`;

function fakeFetch(map: Record<string, string | number>): typeof fetch {
  return (async (url: string) => {
    const v = Object.entries(map).find(([k]) => String(url).includes(k))?.[1];
    if (v === undefined || typeof v === 'number') return { ok: false, status: typeof v === 'number' ? v : 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => v };
  }) as unknown as typeof fetch;
}

async function catalog(): Promise<Catalog> {
  return updateCatalog({ fetchImpl: fakeFetch({ 'claude-plugins-official': MARKETPLACE, 'awesome-claude-code': AWESOME, 'awesome-mcp-servers': AWESOME, 'anthropics/skills': 404, 'awesome-claude-skills': 404 }) });
}

describe('catalog of existing plugins, skills and MCP servers', () => {
  it('parses the official marketplace and the awesome lists, skipping usage trackers, aggregators and tables of contents', async () => {
    const c = await catalog();
    const names = c.entries.map((e) => e.name);
    expect(names).toContain('context7');
    expect(c.entries.find((e) => e.name === 'context7')).toMatchObject({ tier: 'official', install: 'claude plugin install context7@claude-plugins-official' });
    expect(names).toContain('Caveman');
    expect(names).toContain('d/distil');
    expect(names).not.toContain('ccusage');
    expect(names).not.toContain('z/agg');
    expect(names).not.toContain('Skills');
    expect(c.sources.find((s) => s.name === 'anthropic-skills')!.error).toContain('404');
    expect(loadCatalog()!.entries.length).toBe(c.entries.length);
  });

  it('a source that fails keeps its previous entries', async () => {
    await catalog();
    const c = await updateCatalog({ fetchImpl: fakeFetch({ 'claude-plugins-official': 500, 'awesome-claude-code': AWESOME }) });
    expect(c.entries.some((e) => e.name === 'context7')).toBe(true);
  });

  it('ranks by fit and trust, personalised to the repo: Context7 for docs, the LSP for this language only, nothing for unrelated words', async () => {
    const c = await catalog();
    const ts = { languages: ['typescript'], deps: ['react', 'playwright-core'] };
    expect(alternativesFor(c, 'docs', ts, [])[0]!.entry.name).toBe('context7');
    const nav = alternativesFor(c, 'big-reads', ts, []).map((p) => p.entry.name);
    expect(nav[0]).toBe('typescript-lsp');
    expect(nav).not.toContain('gopls-lsp');
    expect(alternativesFor(c, 'docs', ts, ['context7']).map((p) => p.entry.name)).not.toContain('context7');
    expect(alternativesFor(c, 'mcp-output', ts, []).map((p) => p.entry.name)).toContain('d/distil');
    expect(search(c, { id: 't', must: ['token', 'tokens'], boost: ['reduce', 'save', 'saves'], minBoost: 1, avoid: /design tokens?/i }).map((p) => p.entry.name)).not.toContain('figma');
    expect(stackPicks(c, ts, []).map((e) => e.name)).toEqual(['playwright']);
  });

  it('reads the stack from the repo and from app folders one level down', () => {
    const root = tmpDir('tally-stack-');
    fs.mkdirSync(path.join(root, 'app'));
    fs.writeFileSync(path.join(root, 'app', 'package.json'), JSON.stringify({ dependencies: { '@supabase/supabase-js': '1', react: '1' } }));
    fs.writeFileSync(path.join(root, 'app', 'tsconfig.json'), '{}');
    fs.writeFileSync(path.join(root, 'go.mod'), 'module x');
    const s = stackOf(root);
    expect(s.languages.sort()).toEqual(['golang', 'typescript']);
    expect(s.deps).toContain('supabase');
  });

  it('the cost check shows what already exists and swaps a hand-written install for the official plugin', async () => {
    await catalog();
    const t = parseTranscriptFile(path.join(basicFixture, 'transcript.jsonl'));
    /* three docs lookups so the docs pattern fires */
    t.toolCalls.push(...[0, 1, 2].map((i) => ({ id: `w${i}`, name: 'WebFetch', input: { url: 'https://docs.example.dev/api/reference' }, ts: t.messages[0]!.ts, agent: 'main', messageId: t.messages[0]!.id, turn: 1, phase: 'build' as const, result: { isError: false, chars: 80000, text: '' } })));
    const c = computeCheck('cat-1', { transcript: t, estimate: null });
    const docs = c.drivers.find((d) => d.id === 'docs')!;
    expect(docs.alternatives![0]!.name).toBe('context7');
    expect(docs.fix!.apply).toEqual({ kind: 'command', commands: ['claude plugin install context7@claude-plugins-official'] });
    expect(renderCheck(c)).toContain('already built: context7 (official plugin)');
    expect(c.catalog!.entries).toBeGreaterThan(3);
  });

  it('without a catalog the check says how to get one', () => {
    const t = parseTranscriptFile(path.join(basicFixture, 'transcript.jsonl'));
    expect(renderCheck(computeCheck('cat-2', { transcript: t, estimate: null }))).toContain('tally catalog update');
  });

  it('the source list names only official marketplaces and curated lists', () => {
    expect(SOURCES.map((s) => s.tier)).toEqual(['official', 'official', 'curated', 'curated', 'curated']);
    expect(parseAwesome(() => 'mcp')('- [a](https://github.com/a/b) - short', SOURCES[3]!)).toEqual([]);
    void writeJson;
    void ({} as CatalogEntry);
  });
});
