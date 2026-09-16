import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pricingFile, readJson } from '../paths.js';

export interface ModelPrice {
  input: number;
  output: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_read: number;
}

export interface Pricing {
  last_verified: string;
  source?: string;
  models: Record<string, ModelPrice>;
  aliases?: Record<string, string>;
  fallback: string;
}

export interface Usage {
  input: number;
  output: number;
  cache_write: number;
  cache_write_1h?: number;
  cache_read: number;
}

const here = path.dirname(fileURLToPath(import.meta.url));

export function bundledPricingPath(): string {
  const candidates = [path.join(here, 'pricing.json'), path.join(here, '..', '..', 'pricing.json'), path.join(here, '..', 'pricing.json')];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[0]!;
}

let cached: Pricing | null = null;

export function loadPricing(): Pricing {
  if (cached) return cached;
  const bundled = readJson<Pricing | null>(bundledPricingPath(), null);
  const user = readJson<Pricing | null>(pricingFile(), null);
  const p = user ?? bundled;
  if (!p) throw new Error('pricing.json not found');
  cached = p;
  return p;
}

export function resetPricingCache(): void {
  cached = null;
}

export function canonicalModel(model: string | undefined, pricing: Pricing = loadPricing()): string {
  if (!model) return pricing.fallback;
  let m = model.toLowerCase().replace(/\[.*?\]/g, '').trim();
  if (pricing.aliases?.[m]) m = pricing.aliases[m]!;
  m = m.replace(/^(us|eu|apac)\./, '').replace(/^anthropic\./, '');
  const keys = Object.keys(pricing.models).sort((a, b) => b.length - a.length);
  for (const k of keys) if (m === k || m.startsWith(k + '-') || m.startsWith(k + '@')) return k;
  return pricing.fallback;
}

export function priceFor(model: string | undefined, pricing: Pricing = loadPricing()): ModelPrice {
  return pricing.models[canonicalModel(model, pricing)] ?? pricing.models[pricing.fallback]!;
}

export function costOf(usage: Usage, model: string | undefined, pricing: Pricing = loadPricing()): number {
  const p = priceFor(model, pricing);
  const w1h = usage.cache_write_1h ?? 0;
  const w5m = Math.max(0, usage.cache_write - w1h);
  return (
    (usage.input * p.input +
      usage.output * p.output +
      w5m * p.cache_write_5m +
      w1h * p.cache_write_1h +
      usage.cache_read * p.cache_read) /
    1e6
  );
}

export function isModel1M(model: string | undefined): boolean {
  return !!model && /\[1m\]/i.test(model);
}

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cache_write: 0, cache_write_1h: 0, cache_read: 0 };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cache_write: a.cache_write + b.cache_write,
    cache_write_1h: (a.cache_write_1h ?? 0) + (b.cache_write_1h ?? 0),
    cache_read: a.cache_read + b.cache_read,
  };
}

export function fmtUsd(n: number): string {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`;
}
