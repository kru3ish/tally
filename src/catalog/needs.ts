/* What each cost pattern needs from the catalog, personalised to the repo: its languages (for the official language
   server plugins and to skip tools for other languages) and its dependencies (for tools built for its stack). */
import fs from 'node:fs';
import path from 'node:path';
import type { Catalog, CatalogEntry, Need, Pick } from './catalog.js';
import { search } from './catalog.js';

export const MIN_STARS = 50;

export interface Stack {
  languages: string[];
  deps: string[];
}

const LSP: Record<string, string> = {
  typescript: 'typescript-lsp',
  javascript: 'typescript-lsp',
  python: 'pyright-lsp',
  golang: 'gopls-lsp',
  rust: 'rust-analyzer-lsp',
  java: 'jdtls-lsp',
  kotlin: 'kotlin-lsp',
  ruby: 'ruby-lsp',
  php: 'php-lsp',
  'c#': 'csharp-lsp',
  swift: 'swift-lsp',
  c: 'clangd-lsp',
  lua: 'lua-lsp',
};

const read = (f: string) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return '';
  }
};

/* the repo root and, for a monorepo or an app in a subfolder, the folders one level down */
export function stackOf(root: string | undefined): Stack {
  if (!root) return { languages: [], deps: [] };
  const merged = stackAt(root);
  let subs: string[] = [];
  try {
    subs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !['node_modules', 'dist', 'build', 'vendor', 'target'].includes(d.name))
      .map((d) => path.join(root, d.name))
      .slice(0, 30);
  } catch {
    subs = [];
  }
  for (const d of subs) {
    const s = stackAt(d);
    merged.languages = [...new Set([...merged.languages, ...s.languages])];
    merged.deps = [...new Set([...merged.deps, ...s.deps])].slice(0, 120);
  }
  return merged;
}

function stackAt(root: string): Stack {
  const langs = new Set<string>();
  const deps = new Set<string>();
  const has = (f: string) => fs.existsSync(path.join(root, f));
  const pkg = read(path.join(root, 'package.json'));
  if (pkg) {
    langs.add(has('tsconfig.json') || /typescript/.test(pkg) ? 'typescript' : 'javascript');
    try {
      const j = JSON.parse(pkg) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      for (const d of Object.keys({ ...j.dependencies, ...j.devDependencies })) deps.add(d.replace(/^@/, '').split('/')[0]!);
    } catch {
      /* not json */
    }
  }
  const py = read(path.join(root, 'requirements.txt')) + read(path.join(root, 'pyproject.toml'));
  if (py || has('setup.py')) {
    langs.add('python');
    for (const m of py.matchAll(/^\s*["']?([A-Za-z][\w.-]+)/gm)) deps.add(m[1]!.toLowerCase());
  }
  if (has('go.mod')) langs.add('golang');
  if (has('Cargo.toml')) langs.add('rust');
  if (has('pom.xml') || has('build.gradle') || has('build.gradle.kts')) langs.add(has('build.gradle.kts') ? 'kotlin' : 'java');
  if (has('Gemfile')) langs.add('ruby');
  if (has('composer.json')) langs.add('php');
  if (has('Package.swift')) langs.add('swift');
  try {
    if (fs.readdirSync(root).some((f) => f.endsWith('.csproj') || f.endsWith('.sln'))) langs.add('c#');
  } catch {
    /* unreadable */
  }
  /* dependencies too generic to say anything about the stack */
  for (const g of ['types', 'eslint', 'prettier', 'typescript', 'vitest', 'jest', 'tsx', 'ts-node', 'node', 'setuptools', 'wheel', 'pip', 'build', 'tool', 'project', 'name', 'version', 'requires']) deps.delete(g);
  return { languages: [...langs], deps: [...deps].slice(0, 80) };
}

export function lspFor(stack: Stack): string[] {
  return [...new Set(stack.languages.map((l) => LSP[l]).filter(Boolean) as string[])];
}

export function needFor(driverId: string, stack: Stack): Need[] {
  const st = [...stack.languages, ...stack.deps];
  const tokenNeed: Need = {
    id: 'fewer-tokens',
    must: ['token', 'tokens', 'context window', 'compress', 'compression', 'shrink', 'compact'],
    boost: ['reduce', 'reduces', 'save', 'saves', 'saving', 'fewer', 'efficient', 'conserve', 'conserves', 'smaller', 'output', 'session', 'compaction', 'memory'],
    minBoost: 2,
    avoid: /design tokens?|no tokens|api tokens?|access tokens?|auth tokens?|token (?:launch|swap|price|transfer)|crypto|blockchain|wallet|defi|report|dashboard|analytics|monitor|observability|web page|html|scrap/i,
    kinds: ['plugin', 'skill', 'mcp', 'tool'],
    stack: st,
  };
  const codeNav: Need = { id: 'code-navigation', must: ['language server', 'lsp', 'code intelligence', 'symbol', 'symbols', 'semantic code'], boost: ['navigation', 'references', 'definition', 'refactor', ...stack.languages], prefer: lspFor(stack), kinds: ['plugin', 'mcp'], stack: st };
  const explore: Need = { id: 'code-search', must: ['codebase', 'code search', 'semantic search', 'repository map', 'code index', 'repo map'], boost: ['search', 'explore', 'index', 'understand', 'local'], minBoost: 1, avoid: /vector database|data catalog|data assets|warehouse/i, kinds: ['plugin', 'mcp', 'agent', 'tool'], stack: st };
  switch (driverId) {
    case 'docs':
      return [{ id: 'library-docs', must: ['documentation', 'docs'], boost: ['up-to-date', 'library', 'libraries', 'package', 'packages', 'version', 'any', 'framework', 'api reference'], minBoost: 1, prefer: ['context7'], avoid: /internal|company|confluence|notion|knowledge base|database|duckdb|warehouse|data file/i, kinds: ['plugin', 'mcp'], stack: st }];
    case 'big-reads':
      return [codeNav, explore];
    case 'scout':
    case 'story-skill':
      return [explore, codeNav];
    case 'noisy-tests':
      return [{ id: 'test-output', must: ['test output', 'test results', 'test runner', 'test reporter', 'test failures'], boost: ['summary', 'failures', 'quiet', 'token', 'tokens', 'concise', 'run tests'], minBoost: 1, kinds: ['plugin', 'skill', 'mcp', 'tool'], stack: st }];
    case 'compact-window':
    case 'long-context':
      return [{ ...tokenNeed, id: 'context-size', must: ['context window', 'context', 'compaction', 'compact', 'memory'], boost: ['token', 'tokens', 'reduce', 'save', 'saves', 'long', 'session', 'smaller', 'fewer'], minBoost: 2 }];
    case 'bash-output':
      return [{ ...tokenNeed, id: 'command-output', must: ['command output', 'shell output', 'terminal output', 'bash output', 'cli output', 'tool outputs', 'tool output', 'large outputs'], boost: ['token', 'tokens', 'compress', 'shrink', 'truncate', 'reduce', 'filter'], minBoost: 1 }];
    case 'mcp-output':
      return [{ ...tokenNeed, id: 'tool-output', must: ['tool output', 'tool outputs', 'mcp output', 'response size', 'compress', 'shrink'], boost: ['token', 'tokens', 'mcp', 'proxy', 'reduce'], minBoost: 1 }];
    case 'effort':
      return [tokenNeed];
    default:
      return [];
  }
}

/* the best existing tools for a driver: up to `limit`, one need after another, without repeats */
export function alternativesFor(c: Catalog, driverId: string, stack: Stack, installed: string[], limit = 3): Pick[] {
  const out: Pick[] = [];
  const lsps = new Set(lspFor(stack));
  for (const need of needFor(driverId, stack)) {
    for (const p of search(c, need, { installed, limit: limit + 8 })) {
      if (out.length >= limit) break;
      /* a language server for a language this repo does not use is never the answer */
      if (/-lsp$/.test(p.entry.name) && !lsps.has(p.entry.name)) continue;
      /* a community listing with a known, tiny following is not a recommendation */
      if (p.entry.tier === 'curated' && p.entry.stars !== undefined && p.entry.stars < MIN_STARS) continue;
      if (out.some((o) => o.entry.id === p.entry.id) || p.score < 5) continue;
      out.push(p);
    }
  }
  return out;
}

/* official plugins built for something this repo depends on (supabase, stripe, sentry, prisma...), not yet installed */
export function stackPicks(c: Catalog, stack: Stack, installed: string[], limit = 4): CatalogEntry[] {
  const inst = new Set(installed.map((s) => s.toLowerCase()));
  const deps = stack.deps.filter((d) => d.length >= 4);
  const out: CatalogEntry[] = [];
  for (const e of c.entries) {
    if (e.tier !== 'official' || inst.has(e.name.toLowerCase())) continue;
    const name = e.name.toLowerCase().replace(/-(plugin|skills?|mcp|official)$/, '');
    const norm = (d: string) => d.replace(/[-_.]?(js|core|dom|client|sdk|cli|node|server)$/, '');
    if (deps.some((d) => d === name || norm(d) === name || norm(norm(d)) === name)) out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}
