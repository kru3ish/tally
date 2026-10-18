/* Keeps the catalog fresh for the commands that may use the network: refreshed when older than a week, then GitHub
   stars fetched for the curated tools a check is about to recommend. Never fails the caller. */
import { loadConfig } from '../config.js';
import { log } from '../paths.js';
import { enrichStars, isStale, loadCatalog, updateCatalog } from './catalog.js';
import type { CostCheck } from '../estimate/variance.js';

const offline = () => !loadConfig().cost.catalog_online || !!process.env.TALLY_OFFLINE || !!process.env.VITEST;

export async function ensureCatalog(): Promise<void> {
  if (offline()) return;
  if (!isStale(loadCatalog())) return;
  try {
    const c = await updateCatalog({ timeoutMs: 10000 });
    log(`catalog: refreshed, ${c.entries.length} entries`);
  } catch (err) {
    log(`catalog: refresh failed: ${String(err)}`);
  }
}

/* true when stars were added, so the caller can recompute the check with them */
export async function starsFor(check: CostCheck): Promise<boolean> {
  if (offline()) return false;
  const c = loadCatalog();
  if (!c) return false;
  const repos = check.drivers
    .flatMap((d) => d.alternatives ?? [])
    .filter((a) => a.tier === 'curated' && a.stars === undefined && a.url)
    .map((a) => /github\.com\/([\w.-]+\/[\w.-]+)/.exec(a.url!)?.[1] ?? '')
    .filter(Boolean);
  if (!repos.length) return false;
  try {
    return (await enrichStars(c, repos, { max: 10 })) > 0;
  } catch {
    return false;
  }
}
