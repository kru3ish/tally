/* Story metrics over OpenTelemetry (OTLP/HTTP JSON), for teams that already run a collector and a dashboard (Grafana,
   Datadog, Honeycomb, New Relic). Nothing is sent unless an endpoint is configured.

   Claude Code removes OTEL_* variables from the environment it gives hooks (verified on 2.1.302, both from the shell
   and from settings `env`), so the endpoint is looked up in this order:
     1. `tally config cost.otel_endpoint`
     2. TALLY_OTEL_ENDPOINT / TALLY_OTEL_HEADERS / TALLY_OTEL_RESOURCE_ATTRIBUTES (these do reach hooks; put them in
        settings `env`, managed settings included)
     3. OTEL_EXPORTER_OTLP_(METRICS_)ENDPOINT / _HEADERS / OTEL_RESOURCE_ATTRIBUTES in this process's environment
        (a `tally` command run from a shell)
     4. the same OTEL_* keys in the `env` block of Claude Code's user and managed settings files. An organisation
        that rolled out Claude Code's own telemetry through managed settings gets Tally's story metrics at the same
        collector with nothing else to configure.
   A repository must not decide where data goes: like Claude Code (which ignores OTEL_EXPORTER_OTLP_* in project and
   local settings), Tally never reads OTEL_* from the repo's .claude/settings(.local).json, and ignores TALLY_OTEL_*
   when the repo's own settings files are what set it.
   This is the organisation's own pipeline; it is separate from Tally's opt-in anonymous metrics (PRIVACY.md).

   One gauge point per finished story: tally.story.cost, .estimate, .overage, .avoidable (USD), and
   tally.story.driver.cost per driver. Attributes: repo name, story key, model, status, estimate basis, agent, author
   (git user.name), session id. No titles, prompts, code or paths. */
import fs from 'node:fs';
import path from 'node:path';
import { claudeHome } from '../paths.js';
import type { LedgerEntry } from '../estimate/ledger.js';

export interface OtlpTarget {
  url: string;
  headers: Record<string, string>;
  resource?: string;
  source: string;
}

/* the `env` blocks of Claude Code's settings files, lowest precedence first, so a managed (organisation) value wins */
export function managedSettingsPaths(): string[] {
  if (process.platform === 'darwin') return ['/Library/Application Support/ClaudeCode/managed-settings.json'];
  if (process.platform === 'win32') return [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'ClaudeCode', 'managed-settings.json')];
  return ['/etc/claude-code/managed-settings.json'];
}

function managedDropIns(): string[] {
  const dir = path.join(path.dirname(managedSettingsPaths()[0]!), 'managed-settings.d');
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

export function claudeSettingsEnv(files?: string[]): Record<string, string> {
  const list = files ?? [path.join(claudeHome(), 'settings.json'), ...managedSettingsPaths(), ...managedDropIns()];
  const out: Record<string, string> = {};
  for (const f of list) {
    try {
      const env = (JSON.parse(fs.readFileSync(f, 'utf8')) as { env?: Record<string, unknown> }).env ?? {};
      for (const [k, v] of Object.entries(env)) if (k.startsWith('OTEL_') && typeof v === 'string') out[k] = v;
    } catch {
      /* missing or unreadable settings are simply not a source */
    }
  }
  return out;
}

function parsePairs(s: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (s ?? '').split(',')) {
    const i = pair.indexOf('=');
    if (i > 0) out[decodeURIComponent(pair.slice(0, i).trim())] = decodeURIComponent(pair.slice(i + 1).trim());
  }
  return out;
}

const withPath = (u: string) => (u.replace(/\/+$/, '').endsWith('/v1/metrics') ? u : u.replace(/\/+$/, '') + '/v1/metrics');

/* TALLY_OTEL_* that came from the repo's own project or local settings (Claude Code passes those to hooks) */
export function repoSetsTallyOtel(cwd: string | undefined): boolean {
  if (!cwd) return false;
  for (const f of [path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json')]) {
    try {
      const env = (JSON.parse(fs.readFileSync(f, 'utf8')) as { env?: Record<string, unknown> }).env ?? {};
      if (Object.keys(env).some((k) => k.startsWith('TALLY_OTEL_'))) return true;
    } catch {
      /* not there */
    }
  }
  return false;
}

export function otlpTarget(env: NodeJS.ProcessEnv = process.env, configured?: string, settingsEnv: Record<string, string> = {}, opts: { repoSetsTally?: boolean } = {}): OtlpTarget | null {
  const json = { 'content-type': 'application/json' };
  if (configured || (env.TALLY_OTEL_ENDPOINT && !opts.repoSetsTally)) {
    return { url: withPath((configured ?? env.TALLY_OTEL_ENDPOINT)!), headers: { ...json, ...parsePairs(env.TALLY_OTEL_HEADERS) }, resource: env.TALLY_OTEL_RESOURCE_ATTRIBUTES, source: configured ? 'config cost.otel_endpoint' : 'TALLY_OTEL_ENDPOINT' };
  }
  for (const [src, e] of [['environment', env], ['Claude Code settings env', settingsEnv]] as const) {
    /* Tally speaks OTLP/HTTP JSON; a collector set up for gRPC only is not guessed at */
    if ((e.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL ?? e.OTEL_EXPORTER_OTLP_PROTOCOL) === 'grpc') continue;
    const url = e.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ?? (e.OTEL_EXPORTER_OTLP_ENDPOINT ? withPath(e.OTEL_EXPORTER_OTLP_ENDPOINT) : undefined);
    if (url) return { url, headers: { ...json, ...parsePairs(e.OTEL_EXPORTER_OTLP_METRICS_HEADERS ?? e.OTEL_EXPORTER_OTLP_HEADERS) }, resource: e.OTEL_RESOURCE_ATTRIBUTES, source: `OTEL_EXPORTER_OTLP_* (${src})` };
  }
  return null;
}

type Attr = { key: string; value: { stringValue: string } };
const attr = (key: string, v: string | undefined): Attr[] => (v ? [{ key, value: { stringValue: v } }] : []);

export function storyMetrics(e: LedgerEntry, opts: { repo: string; version: string; resource?: string }): Record<string, unknown> {
  const t = String(BigInt(Date.parse(e.ts) || Date.now()) * 1000000n);
  const common: Attr[] = [...attr('repo', opts.repo), ...attr('story.key', e.key), ...attr('model', e.model), ...attr('status', e.status), ...attr('estimate.basis', e.estimate_basis), ...attr('agent', e.agent), ...attr('author', e.author), ...attr('session.id', e.session)];
  const gauge = (name: string, description: string, value: number | undefined, extra: Attr[] = []) =>
    value === undefined ? null : { name, unit: 'USD', description, gauge: { dataPoints: [{ timeUnixNano: t, asDouble: value, attributes: [...common, ...extra] }] } };
  const metrics = [
    gauge('tally.story.cost', 'what the story cost (API-equivalent)', e.actual_usd),
    gauge('tally.story.estimate', 'what similar past stories cost', e.estimate_usd),
    gauge('tally.story.overage', 'cost minus estimate', e.delta_usd),
    gauge('tally.story.avoidable', 'combined saving the cost check found, overlaps counted once', e.savable_usd),
    ...e.drivers.map((d) => gauge('tally.story.driver.cost', 'one cost driver', d.usd, [...attr('driver', d.id), ...attr('fix', d.fix)])),
  ].filter(Boolean);
  /* OTEL_RESOURCE_ATTRIBUTES (k=v,k=v) labels every point with the team, cost centre, etc. */
  const resAttrs: Attr[] = [...attr('service.name', 'tally'), ...attr('service.version', opts.version)];
  for (const [k, v] of Object.entries(parsePairs(opts.resource))) resAttrs.push(...attr(k, v));
  return { resourceMetrics: [{ resource: { attributes: resAttrs }, scopeMetrics: [{ scope: { name: 'tally', version: opts.version }, metrics }] }] };
}

export async function exportStory(e: LedgerEntry, opts: { repo: string; version: string; target: OtlpTarget; timeoutMs?: number; fetchImpl?: typeof fetch }): Promise<{ ok: boolean; status?: number; error?: string }> {
  const body = JSON.stringify(storyMetrics(e, { repo: opts.repo, version: opts.version, resource: opts.target.resource }));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 4000);
  try {
    const r = await (opts.fetchImpl ?? fetch)(opts.target.url, { method: 'POST', headers: opts.target.headers, body, signal: ctrl.signal });
    return { ok: r.ok, status: r.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
